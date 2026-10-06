/**
 * Plotmate / Tuinmaatje – photo inbox for the recognition model.
 *
 * Receives the diagnosis photos that users label and agree to send, and keeps
 * them in your Google Drive in one folder per label ("tomato__late_blight",
 * "lettuce__healthy"), with one row per photo in a Google Sheet. The monthly
 * training (GitHub Actions → Train model) fetches them with ml/fetch_contrib.py.
 *
 * Setting up: see store/fotos-insturen.md. In short:
 *   1. script.google.com → New project → paste this file → Save.
 *   2. Run the function "setup" once (allow access to Drive and Sheets).
 *      The log shows the KEY for GitHub.
 *   3. Deploy → New deployment → Web app; Execute as: Me; Who has access: Anyone.
 *      Give the web app address to the app (ContributionService.UploadLink).
 *
 * Rejecting a photo: drag it in Drive to the folder "Afgekeurd". It is then
 * never used for training.
 *
 * Mail: every evening a short mail when new photos came in (dailyReport, set up
 * by "setup"), and after every training a report sent by GitHub (type "report").
 */

var ROOT_NAME = 'Plotmate - foto\'s van gebruikers';
var REJECTED = 'Afgekeurd';
// The app sends photos of at most 1024 px (± 200 kB); this caps what a stranger can store.
var MAX_BYTES = 1024 * 1024;
var MAX_PER_PHONE_PER_DAY = 30;
var MAX_PER_DAY = 500;
// Where the mails go: new photos and the training reports.
var MAIL_TO = 'basdelouw78@gmail.com';

/** Run once by hand: makes the folder, the sheet and the key for GitHub. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var root = rootFolder_();
  folderIn_(root, REJECTED);
  sheet_();
  if (!props.getProperty('KEY')) {
    props.setProperty('KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('Folder: ' + root.getUrl());
  Logger.log('Sheet: ' + SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl());
  Logger.log('KEY for GitHub (secret CONTRIB_KEY): ' + props.getProperty('KEY'));
  // Every evening around 19:00 a mail when new photos came in (one trigger, also after running setup again).
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'dailyReport'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(19).create();
  if (!props.getProperty('LAST_REPORT')) props.setProperty('LAST_REPORT', String(Date.now()));
  Logger.log('Daily mail about new photos to ' + MAIL_TO + ' is on.');
}

/** Every evening: which photos came in since the last mail. No mail when there are none. */
function dailyReport() {
  var props = PropertiesService.getScriptProperties();
  var since = Number(props.getProperty('LAST_REPORT') || 0);
  var now = Date.now();
  var rows = sheet_().getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0] instanceof Date && r[0].getTime() > since; });
  props.setProperty('LAST_REPORT', String(now));
  if (rows.length === 0) return;

  var perLabel = {};
  var wrong = 0;
  var described = [];
  rows.forEach(function (r) {
    var label = String(r[1]);
    perLabel[label] = (perLabel[label] || 0) + 1;
    if (r[4] === 'nee') wrong++;
    if (/__other$/.test(label)) described.push('• ' + label.replace('__other', '') + ': "' + (r[11] || '(geen omschrijving)') + '"  ' + r[10]);
  });
  var lines = Object.keys(perLabel).sort().map(function (l) { return '• ' + l + ': ' + perLabel[l]; });
  var text = rows.length + ' nieuwe foto(\'s) ontvangen.\n\n' +
    'Per label:\n' + lines.join('\n') + '\n\n' +
    'Het model zat ' + wrong + ' keer mis (kolom "Eens" = nee).\n' +
    (described.length ? '\nZelf beschreven (naar de goede map slepen als je weet wat het is):\n' + described.join('\n') + '\n' : '') +
    '\nSpreadsheet: ' + SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl() +
    '\nMap: ' + rootFolder_().getUrl();
  MailApp.sendEmail(MAIL_TO, 'Tuinmaatje: ' + rows.length + ' nieuwe foto(\'s)', text);
}

/** A photo from the app. */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // The training report from GitHub Actions (ml/mail_report.py), only with the KEY.
    if (body.type === 'report') {
      var key = PropertiesService.getScriptProperties().getProperty('KEY');
      if (!key || body.key !== key) return json_({ ok: false, error: 'key' });
      MailApp.sendEmail(MAIL_TO, String(body.subject || 'Tuinmaatje: training').slice(0, 200), String(body.text || '').slice(0, 20000));
      return json_({ ok: true });
    }
    var label = String(body.label || '');
    if (!/^[a-z0-9_]{1,40}__[a-z0-9_]{1,60}$/.test(label)) {
      return json_({ ok: false, error: 'label' });
    }
    var bytes = Utilities.base64Decode(String(body.image || ''));
    if (bytes.length < 1000 || bytes.length > MAX_BYTES || (bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8) {
      return json_({ ok: false, error: 'image' });
    }
    var contributor = String(body.contributor || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
    if (!allowed_(contributor)) {
      // Too many today: the app counts it as sent, so it does not try again and again.
      return json_({ ok: true, skipped: 'limit' });
    }

    var now = new Date();
    var stamp = Utilities.formatDate(now, 'UTC', 'yyyyMMdd-HHmmss');
    var name = stamp + '-' + Utilities.getUuid().slice(0, 8) + '.jpg';
    var folder = folderIn_(rootFolder_(), label);
    var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));

    var predicted = String(body.predicted || '').slice(0, 120);
    var sheet = sheet_();
    // Older sheets have no column for the user's own description yet.
    if (sheet.getRange(1, 12).getValue() === '') sheet.getRange(1, 12).setValue('Omschrijving gebruiker');
    sheet.appendRow([
      now, label, predicted, body.probability === null || body.probability === undefined ? '' : Number(body.probability),
      predicted === label ? 'ja' : (predicted ? 'nee' : ''),
      String(body.month || '').slice(0, 7), String(body.app || '').slice(0, 60), String(body.language || '').slice(0, 5),
      contributor.slice(0, 8), name, file.getUrl(), String(body.note || '').slice(0, 200),
    ]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/**
 * For the training only (needs the KEY):
 *   ?key=…&list=1   → all usable photos: [{ id, label, name }]
 *   ?key=…&id=…     → one photo: { id, data } (base64)
 */
function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || !e || !e.parameter || e.parameter.key !== key) {
    return json_({ ok: false, error: 'key' });
  }
  var root = rootFolder_();
  if (e.parameter.list) {
    var photos = [];
    var folders = root.getFolders();
    while (folders.hasNext()) {
      var folder = folders.next();
      if (folder.getName() === REJECTED) continue;
      var files = folder.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        if (f.getMimeType() === 'image/jpeg') {
          photos.push({ id: f.getId(), label: folder.getName(), name: f.getName() });
        }
      }
    }
    return json_({ ok: true, photos: photos });
  }
  if (e.parameter.id) {
    var file = DriveApp.getFileById(e.parameter.id);
    var parents = file.getParents();
    // Only photos inside the inbox, and not rejected ones.
    var inside = false;
    while (parents.hasNext()) {
      var parent = parents.next();
      var grand = parent.getParents();
      if (parent.getName() !== REJECTED && grand.hasNext() && grand.next().getId() === root.getId()) inside = true;
    }
    if (!inside) return json_({ ok: false, error: 'not found' });
    return json_({ ok: true, id: file.getId(), data: Utilities.base64Encode(file.getBlob().getBytes()) });
  }
  return json_({ ok: true });
}

function allowed_(contributor) {
  var cache = CacheService.getScriptCache();
  var day = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  var phoneKey = 'p' + day + contributor;
  var allKey = 'a' + day;
  var phone = Number(cache.get(phoneKey) || 0);
  var all = Number(cache.get(allKey) || 0);
  if (phone >= MAX_PER_PHONE_PER_DAY || all >= MAX_PER_DAY) return false;
  cache.put(phoneKey, String(phone + 1), 21600);
  cache.put(allKey, String(all + 1), 21600);
  return true;
}

function rootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROOT_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // Deleted: make a new one.
    }
  }
  var folder = DriveApp.createFolder(ROOT_NAME);
  props.setProperty('ROOT_ID', folder.getId());
  return folder;
}

function folderIn_(parent, name) {
  var found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

function sheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id).getSheets()[0];
    } catch (err) {
      // Deleted: make a new one.
    }
  }
  var book = SpreadsheetApp.create('Plotmate - ingestuurde foto\'s');
  var sheet = book.getSheets()[0];
  sheet.appendRow(['Ontvangen', 'Label (gebruiker)', 'Model zei', 'Zekerheid', 'Eens', 'Maand', 'App', 'Taal',
    'Telefoon (anoniem)', 'Bestand', 'Link', 'Omschrijving gebruiker']);
  sheet.setFrozenRows(1);
  props.setProperty('SHEET_ID', book.getId());
  DriveApp.getFileById(book.getId()).moveTo(rootFolder_());
  return sheet;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
