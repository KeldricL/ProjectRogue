const SPREADSHEET_ID = '1JFiOvh15R9TDzrr0GYzehGbgVvRwD5d7f7aYm9j0NkY';
const SHEET_NAME = 'Master';

const HEADER_ROW = 35;
const FIRST_DATA_ROW = 36;
const FIRST_COLUMN = 1;
const COLUMN_COUNT = 47; // A through AU

const MASTER_CACHE_MANIFEST_KEY = 'masterDataCacheManifest_v1';
const MASTER_CACHE_TTL_SECONDS = 7200; // Two hours, refreshed by the hourly trigger.
const MASTER_CACHE_CHUNK_LENGTH = 20000; // Stay safely below CacheService's per-item size limit.

function doGet(e) {
  try {
    const callback = e && e.parameter ? e.parameter.callback : null;
    if (e && e.parameter && e.parameter.mode === 'latestVideos') {
      return output_(getLatestVideos_(), callback);
    }

    return output_(getMasterData_(), callback);

  } catch (error) {
    const callback = e && e.parameter ? e.parameter.callback : null;
    return output_({ error: error.message }, callback);
  }
}

function getMasterData_() {
  let result = readMasterDataCache_();
  if (result) return result;

  // Contention should never turn into a page error. Keep the normal single
  // builder path, but if another execution owns the lock, rebuild without
  // waiting for that execution to finish.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    result = buildMasterData_();
    writeMasterDataCache_(result);
    return result;
  }

  try {
    result = readMasterDataCache_();
    if (result) return result;

    result = buildMasterData_();
    writeMasterDataCache_(result);
    return result;
  } finally {
    lock.releaseLock();
  }
}
function buildMasterData_() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error('Master worksheet was not found.');
  }

  const lastRow = sheet.getLastRow();
  const headers = sheet
    .getRange(HEADER_ROW, FIRST_COLUMN, 1, COLUMN_COUNT)
    .getDisplayValues()[0];

  let records = [];

  if (lastRow >= FIRST_DATA_ROW) {
    const rowCount = lastRow - FIRST_DATA_ROW + 1;
    const range = sheet.getRange(
      FIRST_DATA_ROW,
      FIRST_COLUMN,
      rowCount,
      COLUMN_COUNT
    );

    const values = range.getDisplayValues();

    // The frontend only uses linked URLs from columns B and C, and notes
    // from column A. Reading rich text, formulas, and notes for every cell
    // in the full 47-column range makes cache refreshes unnecessarily slow.
    const linkRange = sheet.getRange(FIRST_DATA_ROW, 2, rowCount, 2);
    const richText = linkRange.getRichTextValues();
    const formulas = linkRange.getFormulas();
    const nameNotes = sheet.getRange(FIRST_DATA_ROW, 1, rowCount, 1).getNotes();

    records = values
      .map((row, rowIndex) => {
        if (!row[0] || !row[0].trim()) return null;

        return row.map((displayText, colIndex) => {
          let url = null;
          if (colIndex === 1 || colIndex === 2) {
            const linkIndex = colIndex - 1;
            const richCell = richText[rowIndex][linkIndex];
            url = richCell ? richCell.getLinkUrl() : null;

            if (!url) {
              const formula = formulas[rowIndex][linkIndex];
              const match = formula.match(
                /^=HYPERLINK\(\s*"([^"]+)"/i
              );

              if (match) url = match[1];
            }
          }

          // Only send notes from column A (Game Name) to the public frontend.
          const note = colIndex === 0 ? nameNotes[rowIndex][0] : '';

          return {
            text: displayText,
            url: url || null,
            note: note || ''
          };
        });
      })
      .filter(record => record !== null);
  }

  return {
    headers: headers,
    rows: records,
    totalRecords: records.length
  };
}

function readMasterDataCache_() {
  const cache = CacheService.getScriptCache();
  const manifestText = cache.get(MASTER_CACHE_MANIFEST_KEY);
  if (!manifestText) return null;

  try {
    const manifest = JSON.parse(manifestText);
    if (!manifest || !manifest.version || !Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 1) {
      return null;
    }

    let json = '';
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const chunk = cache.get(masterCacheChunkKey_(manifest.version, index));
      if (chunk === null) return null;
      json += chunk;
    }

    return JSON.parse(json);
  } catch (_error) {
    return null;
  }
}

function writeMasterDataCache_(result) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(result);
    const chunks = splitMasterCacheText_(json);
    const version = String(Date.now()) + '_' + Math.random().toString(36).slice(2);

    chunks.forEach((chunk, index) => {
      cache.put(
        masterCacheChunkKey_(version, index),
        chunk,
        MASTER_CACHE_TTL_SECONDS
      );
    });

    // Publish the manifest last so readers never select an incomplete snapshot.
    cache.put(
      MASTER_CACHE_MANIFEST_KEY,
      JSON.stringify({ version: version, chunkCount: chunks.length }),
      MASTER_CACHE_TTL_SECONDS
    );
    return true;
  } catch (error) {
    // CacheService is best-effort; serve the freshly built data even if caching fails.
    console.error('Could not write the Master data cache: ' + error.message);
    return false;
  }
}

function splitMasterCacheText_(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + MASTER_CACHE_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

function masterCacheChunkKey_(version, index) {
  return 'masterDataCache_' + version + '_' + index;
}

function refreshMasterDataCache() {
  // Cache entries are written under a new version and the manifest is
  // published last, so readers never need a global lock during refresh.
  const result = buildMasterData_();
  const cached = writeMasterDataCache_(result);
  if (cached) {
    console.log('Refreshed Master data cache with ' + result.totalRecords + ' records.');
  } else {
    console.error('Built Master data with ' + result.totalRecords + ' records, but could not save the cache.');
  }
  return result.totalRecords;
}
function installHourlyMasterDataCacheRefresh() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'refreshMasterDataCache')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('refreshMasterDataCache')
    .timeBased()
    .everyHours(1)
    .create();

  return refreshMasterDataCache();
}

function getLatestVideos_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('latestYoutubeVideos_v5');
  if (cached) return JSON.parse(cached);

  const apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!apiKey) {
    throw new Error('Missing Script Property YOUTUBE_API_KEY. Add a restricted YouTube Data API key.');
  }

  const channelId = 'UCz9QiF5eyTte6FoZQIKRCeA';
  const channelData = youtubeDataApiGet_('channels', {
    part: 'contentDetails',
    id: channelId
  }, apiKey);
  const channel = channelData.items && channelData.items.length ? channelData.items[0] : null;
  const uploadsPlaylistId = channel && channel.contentDetails && channel.contentDetails.relatedPlaylists
    ? channel.contentDetails.relatedPlaylists.uploads
    : '';
  if (!uploadsPlaylistId) throw new Error('YouTube did not return an uploads playlist for this channel.');

  const playlistData = youtubeDataApiGet_('playlistItems', {
    part: 'snippet',
    playlistId: uploadsPlaylistId,
    // Read enough recent uploads to still fill the 10-card section after
    // vertical versions are excluded.
    maxResults: 50
  }, apiKey);
  const videos = (playlistData.items || []).map(function (item) {
    const snippet = item.snippet || {};
    const title = snippet.title || 'YouTube video';
    if (/\[vertical\]/i.test(title)) return null;
    const resource = snippet.resourceId || {};
    const id = resource.videoId || '';
    if (!id) return null;

    const thumbnails = snippet.thumbnails || {};
    const thumbnail = thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default || {};
    return {
      id: id,
      title: title,
      description: snippet.description || '',
      url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
      thumbnail: thumbnail.url || 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg'
    };
  }).filter(function (video) { return video !== null; }).slice(0, 10);

  const result = { feedVersion: 1, videos: videos };
  cache.put('latestYoutubeVideos_v5', JSON.stringify(result), 600);
  return result;
}

function youtubeDataApiGet_(resource, parameters, apiKey) {
  const query = Object.keys(parameters).map(function (name) {
    return encodeURIComponent(name) + '=' + encodeURIComponent(parameters[name]);
  }).join('&');
  const response = UrlFetchApp.fetch(
    'https://www.googleapis.com/youtube/v3/' + resource + '?' + query,
    {
      headers: { 'x-goog-api-key': apiKey },
      muteHttpExceptions: true
    }
  );
  const responseText = response.getContentText();
  if (response.getResponseCode() !== 200) {
    let detail = '';
    try {
      const errorBody = JSON.parse(responseText);
      detail = errorBody.error && errorBody.error.message ? ': ' + errorBody.error.message : '';
    } catch (_error) {}
    throw new Error('YouTube Data API ' + resource + '.list returned HTTP ' + response.getResponseCode() + detail);
  }
  return JSON.parse(responseText);
}

function output_(value, callback) {
  const json = JSON.stringify(value);
  if (callback && /^[a-zA-Z_$][0-9a-zA-Z_$\.]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
