// ────────────────────────────────────────────
//  Message listener
// ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchData") {
    handleFullFlow(sendResponse);
    return true; // Keep channel open
  }
  if (request.action === "uploadLinks") {
    handleUploadLinks(request.notebookId, request.urls, sendResponse);
    return true;
  }
});

// ────────────────────────────────────────────
//  Context menu – dynamic sub-menu
// ────────────────────────────────────────────
const CACHE_KEY = 'nlm_notebooks';
const RECENT_KEY = 'nlm_recent';
const MAX_RECENT = 3;
const PENDING_KEY = 'nlm_pending_link';

// Build (or rebuild) the context menu tree
async function rebuildContextMenu() {
  // Remove all existing items first
  await chrome.contextMenus.removeAll();

  // Parent item – always present
  chrome.contextMenus.create({
    id: 'nlm-parent',
    title: 'Upload to NotebookLM',
    contexts: ['link'],
  });

  // Load recents + cached notebooks to resolve titles
  const data = await chrome.storage.local.get([RECENT_KEY, CACHE_KEY]);
  const recents = data[RECENT_KEY] || [];
  const notebooks = data[CACHE_KEY] || [];

  if (recents.length > 0 && notebooks.length > 0) {
    const nbMap = new Map(notebooks.map(nb => [nb.id, nb]));

    recents.forEach((id, idx) => {
      const nb = nbMap.get(id);
      if (!nb) return;
      chrome.contextMenus.create({
        id: `nlm-recent-${idx}`,
        parentId: 'nlm-parent',
        title: `${nb.emoji} ${nb.title}`,
        contexts: ['link'],
      });
    });

    // Separator
    chrome.contextMenus.create({
      id: 'nlm-sep',
      parentId: 'nlm-parent',
      type: 'separator',
      contexts: ['link'],
    });
  }

  // "More…" opens the popup
  chrome.contextMenus.create({
    id: 'nlm-more',
    parentId: 'nlm-parent',
    title: 'More notebooks…',
    contexts: ['link'],
  });
}

// Handle context-menu clicks
chrome.contextMenus.onClicked.addListener(async (info) => {
  const linkUrl = info.linkUrl;
  if (!linkUrl) return;

  // "More…" – save the link and open the popup
  if (info.menuItemId === 'nlm-more') {
    await chrome.storage.local.set({ [PENDING_KEY]: linkUrl });
    // Open the popup programmatically (opens as a new window because
    // service workers cannot trigger the action popup directly)
    const popupURL = chrome.runtime.getURL('popup.html') + '?pending=1';
    chrome.windows.create({
      url: popupURL,
      type: 'popup',
      width: 420,
      height: 560,
      focused: true,
    });
    return;
  }

  // Recent-notebook shortcut – upload directly
  if (info.menuItemId.startsWith('nlm-recent-')) {
    const idx = parseInt(info.menuItemId.replace('nlm-recent-', ''), 10);
    const data = await chrome.storage.local.get([RECENT_KEY, CACHE_KEY]);
    const recents = data[RECENT_KEY] || [];
    const notebooks = data[CACHE_KEY] || [];
    const nbId = recents[idx];
    if (!nbId) return;
    const nb = notebooks.find(n => n.id === nbId);

    // Upload the single link
    try {
      await handleUploadLinksAsync(nbId, [linkUrl]);
      // Show a transient badge to confirm success
      chrome.action.setBadgeBackgroundColor({ color: '#1b6e2d' });
      chrome.action.setBadgeText({ text: '✓' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
    } catch (e) {
      chrome.action.setBadgeBackgroundColor({ color: '#ba1a1a' });
      chrome.action.setBadgeText({ text: '✗' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
      console.error('Context-menu upload failed:', e);
    }
  }
});

// Promisified version of handleUploadLinks for internal use
function handleUploadLinksAsync(notebookId, urls) {
  return new Promise((resolve, reject) => {
    handleUploadLinks(notebookId, urls, (response) => {
      if (response.success) resolve(response);
      else reject(new Error(response.error || 'Upload failed'));
    });
  });
}

// Rebuild on install / startup
chrome.runtime.onInstalled.addListener(() => rebuildContextMenu());
chrome.runtime.onStartup.addListener(() => rebuildContextMenu());

// Rebuild whenever the recents or notebook cache changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[RECENT_KEY] || changes[CACHE_KEY])) {
    rebuildContextMenu();
  }
});

// Google Drive URL patterns — two methods:
//   'export' = export the file, then upload the bytes (Docs, Slides)
//   'drive'  = shortcut via izAoDd with file ID + mimeType (Sheets, generic Drive files)
const GDRIVE_PATTERNS = [
  // --- Export + Upload ---
  {
    regex: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    method: 'export',
    exportPath: 'document',
    format: 'docx',
  },
  {
    regex: /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    method: 'export',
    exportPath: 'presentation',
    format: 'pdf',
  },
  // --- Drive Shortcut ---
  {
    regex: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    method: 'drive',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    defaultTitle: 'Spreadsheet',
  },
  {
    regex: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    method: 'drive',
    mimeType: 'application/octet-stream',
    defaultTitle: 'Drive file',
  },
  {
    regex: /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    method: 'drive',
    mimeType: 'application/octet-stream',
    defaultTitle: 'Drive file',
  },
];

function parseGoogleDriveUrl(url) {
  for (const pattern of GDRIVE_PATTERNS) {
    const match = url.match(pattern.regex);
    if (match) {
      const info = { fileId: match[1], method: pattern.method, originalUrl: url };
      if (pattern.method === 'export') {
        info.exportPath = pattern.exportPath;
        info.format = pattern.format;
      } else {
        info.mimeType = pattern.mimeType;
        info.defaultTitle = pattern.defaultTitle;
      }
      return info;
    }
  }
  return null;
}

async function handleUploadLinks(notebookId, urls, sendResponse) {
  try {
    const driveLinks = [];
    const webLinks = [];

    // Split URLs into Google Drive links and regular web links
    for (const url of urls) {
      const driveInfo = parseGoogleDriveUrl(url);
      if (driveInfo) {
        driveLinks.push(driveInfo);
      } else {
        webLinks.push(url);
      }
    }

    console.log(`Uploading ${webLinks.length} web link(s) and ${driveLinks.length} Google Drive link(s)`);

    // 1. Get the 'at' token
    const htmlRes = await fetch('https://notebooklm.google.com/');
    const html = await htmlRes.text();
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
    if (!atToken) throw new Error("Could not find auth token. Are you logged in?");

    const results = { webSuccess: true, driveSuccess: true, errors: [] };

    // 2. Upload regular web links (if any)
    if (webLinks.length > 0) {
      try {
        await uploadWebLinks(notebookId, webLinks, atToken);
      } catch (e) {
        results.webSuccess = false;
        results.errors.push(`Web links: ${e.message}`);
      }
    }

    // 3. Upload Google Drive links (if any)
    if (driveLinks.length > 0) {
      try {
        await uploadDriveLinks(notebookId, driveLinks, atToken);
      } catch (e) {
        results.driveSuccess = false;
        results.errors.push(`Drive links: ${e.message}`);
      }
    }

    const allSuccess = results.webSuccess && results.driveSuccess;
    sendResponse({
      success: allSuccess,
      count: urls.length,
      ...(results.errors.length > 0 && { errors: results.errors })
    });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function uploadWebLinks(notebookId, urls, atToken) {
  const linkItems = urls.map(url => [null, null, [url], null, null, null, null, null, null, null, 1]);
  const innerPayload = [linkItems, notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
  const rpcid = "izAoDd";
  const fReq = JSON.stringify([[[rpcid, JSON.stringify(innerPayload), null, "generic"]]]);

  const response = await fetch(
    `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=${rpcid}&source-path=%2Fnotebook%2F${notebookId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ "f.req": fReq, "at": atToken })
  });

  if (!response.ok) throw new Error(`Server responded with ${response.status}`);
}

async function uploadDriveLinks(notebookId, driveFiles, atToken) {
  const exportFiles = driveFiles.filter(f => f.method === 'export');
  const driveShortcutFiles = driveFiles.filter(f => f.method === 'drive');

  // Handle export files (Docs, Slides) — export + 3-step upload
  for (const file of exportFiles) {
    console.log(`Exporting Drive file ${file.fileId} as ${file.format}...`);

    // 1. Export the file from Google Drive (follows 307 redirect)
    const exportUrl = `https://docs.google.com/${file.exportPath}/u/0/export?format=${file.format}&id=${file.fileId}`;
    const exportRes = await fetch(exportUrl, { redirect: 'follow' });

    if (!exportRes.ok) {
      throw new Error(`Failed to export Drive file ${file.fileId}: ${exportRes.status}`);
    }

    const fileBlob = await exportRes.blob();
    const fileName = `${file.fileId}.${file.format}`;
    console.log(`Downloaded ${fileName} (${fileBlob.size} bytes)`);

    // 2. Create the source entry in NotebookLM (rpcid: o4cbdc)
    const sourceId = await createSourceEntry(notebookId, fileName, atToken);
    console.log(`Created source entry: ${sourceId}`);

    // 3. Initiate resumable upload session
    const uploadUrl = await initiateUpload(notebookId, fileName, sourceId, fileBlob.size);
    console.log(`Got upload URL: ${uploadUrl}`);

    // 4. Upload the actual file bytes
    await uploadFileBytes(uploadUrl, fileBlob);
    console.log(`Successfully uploaded ${fileName} to NotebookLM`);
  }

  // Handle drive shortcut files (Sheets, generic Drive) — single izAoDd call
  if (driveShortcutFiles.length > 0) {
    await uploadDriveShortcut(notebookId, driveShortcutFiles, atToken);
  }
}

async function uploadDriveShortcut(notebookId, driveFiles, atToken) {
  // Each Drive shortcut item: [fileId, mimeType, 1, title], then nulls, then 1
  const driveItems = driveFiles.map(file => [
    [file.fileId, file.mimeType, 1, file.defaultTitle],
    null, null, null, null, null, null, null, null, null, 1
  ]);

  const innerPayload = [driveItems, notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
  const rpcid = "izAoDd";
  const fReq = JSON.stringify([[[rpcid, JSON.stringify(innerPayload), null, "generic"]]]);

  console.log(`Uploading ${driveFiles.length} Drive file(s) via shortcut...`);

  const response = await fetch(
    `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=${rpcid}&source-path=%2Fnotebook%2F${notebookId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ "f.req": fReq, "at": atToken })
  });

  if (!response.ok) throw new Error(`Drive shortcut upload failed: ${response.status}`);
  console.log(`Successfully uploaded ${driveFiles.length} Drive file(s) via shortcut`);
}

async function createSourceEntry(notebookId, fileName, atToken) {
  const rpcid = "o4cbdc";
  const innerPayload = [[[fileName]], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
  const fReq = JSON.stringify([[[rpcid, JSON.stringify(innerPayload), null, "generic"]]]);

  const response = await fetch(
    `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=${rpcid}&source-path=%2Fnotebook%2F${notebookId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ "f.req": fReq, "at": atToken })
  });

  if (!response.ok) throw new Error(`Failed to create source entry: ${response.status}`);

  // Parse the response to extract the source ID
  const text = await response.text();
  const cleanJson = JSON.parse(text.replace(/^\)\]\}'[\s]*/, ""));
  const rawDataString = cleanJson[0][2];
  const parsedData = JSON.parse(rawDataString);

  // Source ID is at [0][0][0][0]
  const sourceId = parsedData[0][0][0][0];
  if (!sourceId) throw new Error("Could not extract source ID from response");

  return sourceId;
}

async function initiateUpload(notebookId, fileName, sourceId, fileSize) {
  const response = await fetch('https://notebooklm.google.com/upload/_/?authuser=0', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
    },
    body: JSON.stringify({
      PROJECT_ID: notebookId,
      SOURCE_NAME: fileName,
      SOURCE_ID: sourceId,
    }),
  });

  if (!response.ok) throw new Error(`Failed to initiate upload: ${response.status}`);

  // The upload URL comes back in the X-Goog-Upload-Url header
  const uploadUrl = response.headers.get('X-Goog-Upload-Url');
  if (!uploadUrl) throw new Error("Could not get upload URL from response headers");

  return uploadUrl;
}

async function uploadFileBytes(uploadUrl, fileBlob) {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: fileBlob,
  });

  if (!response.ok) throw new Error(`Failed to upload file: ${response.status}`);
}

async function handleFullFlow(sendResponse) {
  try {
    // 1. Get the 'at' token
    const htmlRes = await fetch('https://notebooklm.google.com/');
    const html = await htmlRes.text();
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1];

    if (!atToken) throw new Error("Could not find auth token. Are you logged in?");

    // 2. Fetch the notebooks (rpcid: wXbhsf)
    const rpcid = "wXbhsf";
    const fReq = JSON.stringify([[[rpcid, JSON.stringify([null, 1, null, [2]]), null, "generic"]]]);

    const response = await fetch(`https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=${rpcid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ "f.req": fReq, "at": atToken })
    });

    const text = await response.text();
    const cleanJson = JSON.parse(text.replace(/^\)\]\}'\s*/, ""));

    // 3. The "Array Hell" Parser
    // The actual notebook list is usually stringified JSON inside the first valid data block
    const rawDataString = cleanJson[0][2];
    const parsedData = JSON.parse(rawDataString);

    // 2. ב-rpcid הזה (wXbhsf), רשימת המחברות נמצאת תמיד באינדקס 0
    const notebooksRawList = parsedData[0];

    // 3. מיפוי האינדקסים לפי ה-Response האמיתי שלך:
    // [0] = כותרת, [1] = רשימת מקורות, [2] = Notebook ID, [3] = Emoji
    const formattedNotebooks = notebooksRawList
      .filter(nb => Array.isArray(nb) && nb.length >= 3) // מוודא שזה אכן אובייקט של מחברת
      .map(nb => ({
        title: nb[0] || "Untitled Notebook",
        id: nb[2] || "no-id",
        emoji: nb[3] || "📔",
        sourceCount: Array.isArray(nb[1]) ? nb[1].length : 0
      }));

    console.log("Parsed Notebooks:", formattedNotebooks);
    sendResponse({ success: true, notebooks: formattedNotebooks });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}