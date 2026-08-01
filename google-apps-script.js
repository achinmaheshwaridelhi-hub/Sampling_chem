/**
 * Biomass Sampling - Google Apps Script Backend (google-apps-script.js)
 * Paste this code into Google Sheets > Extensions > Apps Script to deploy the REST API.
 * 
 * ====================================================================================
 * SCHEMA AND INITIALIZATION
 * This script will AUTOMATICALLY initialize all sheets and default logins on first run.
 * You just need to create a blank Google Spreadsheet, open Extensions > Apps Script,
 * paste this code, and Deploy as a Web App (Execute as: Me, Access: Anyone).
 * ====================================================================================
 */

const DB = SpreadsheetApp.getActiveSpreadsheet();

// Automatic acceptance rule shared by every backend action
var MOISTURE_REJECT_LIMIT = 14;

function evaluateAcceptance(moisturePct) {
    if (moisturePct === null || moisturePct === undefined || moisturePct === '') return 'PENDING';
    return Number(moisturePct) >= MOISTURE_REJECT_LIMIT ? 'REJECTED' : 'ACCEPTED';
}

// Writes a value into a named column, creating nothing (column must already exist)
function setCellByHeader(sheet, rowIndex, headerName, value) {
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const idx = headers.indexOf(headerName);
    if (idx === -1) return false;
    sheet.getRange(rowIndex, idx + 1).setValue(value);
    return true;
}

// Auto-initialize sheets and headers if they do not exist
function initializeDatabase() {
    const trucksSheet = getOrCreateSheet('Trucks', [
        'truck_id', 'company_name', 'driver_name', 'truck_reg_number', 'entry_date', 'entry_time', 
        'photo_url', 'gross_weight', 'tare_weight', 'net_weight', 'sample1_barcode_id', 
        'composite_barcode_id', 'created_by', 'daily_group_code', 'invoice_no', 'challan_no', 'acceptance_status'
    ]);
    
    // Ensure newer columns are added to existing spreadsheets if missing (order matters: appended at the end)
    let lastCol = trucksSheet.getLastColumn();
    if (lastCol > 0) {
        let headers = trucksSheet.getRange(1, 1, 1, lastCol).getValues()[0];
        ['daily_group_code', 'invoice_no', 'challan_no', 'acceptance_status'].forEach(function(col) {
            if (headers.indexOf(col) === -1) {
                lastCol = trucksSheet.getLastColumn();
                trucksSheet.getRange(1, lastCol + 1).setValue(col);
                headers = trucksSheet.getRange(1, 1, 1, lastCol + 1).getValues()[0];
            }
        });
    }
    
    const lab1Sheet = getOrCreateSheet('Lab1Results', [
        'sample1_barcode_id', 'moisture_pct', 'fineness_value', 'tested_by', 'tested_at',
        'moisture_by', 'moisture_at', 'fineness_by', 'fineness_at'
    ]);
    
    // Ensure the split moisture / fineness audit columns exist on older spreadsheets
    let lab1LastCol = lab1Sheet.getLastColumn();
    if (lab1LastCol > 0) {
        let lab1Headers = lab1Sheet.getRange(1, 1, 1, lab1LastCol).getValues()[0];
        ['moisture_by', 'moisture_at', 'fineness_by', 'fineness_at'].forEach(function(col) {
            if (lab1Headers.indexOf(col) === -1) {
                lab1LastCol = lab1Sheet.getLastColumn();
                lab1Sheet.getRange(1, lab1LastCol + 1).setValue(col);
                lab1Headers = lab1Sheet.getRange(1, 1, 1, lab1LastCol + 1).getValues()[0];
            }
        });
    }
    
    const compositeSheet = getOrCreateSheet('CompositeBatches', [
        'composite_ref_id', 'composite_barcode_id', 'company_name', 'date', 'parent_truck_ids', 
        'gcv_value', 'ash_pct', 'tested_by', 'tested_at', 'test_lot', 'referee_lot', 'vendor_lot',
        'system_samples_count', 'mixed_samples_count', 'daily_group_code',
        'vendor_gcv', 'referee_gcv', 'referee_status', 'referee_updated_at'
    ]);
    
    // Ensure audit & referee challenge columns exist on existing spreadsheets if missing
    let lastCompCol = compositeSheet.getLastColumn();
    if (lastCompCol > 0) {
        let headers = compositeSheet.getRange(1, 1, 1, lastCompCol).getValues()[0];
        ['system_samples_count', 'mixed_samples_count', 'daily_group_code', 'vendor_gcv', 'referee_gcv', 'referee_status', 'referee_updated_at'].forEach(function(colName) {
            if (headers.indexOf(colName) === -1) {
                lastCompCol = compositeSheet.getLastColumn();
                compositeSheet.getRange(1, lastCompCol + 1).setValue(colName);
                headers = compositeSheet.getRange(1, 1, 1, lastCompCol + 1).getValues()[0];
            }
        });
    }
    
    const usersSheet = getOrCreateSheet('Users', ['username', 'password', 'role', 'name']);
    const existingUsers = getSheetRows('Users');
    const defaultUsers = [
        ['admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', 'System Administrator'],
        ['entry', '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf', 'entry', 'Entry Gate Operator'],
        ['lab1', '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609', 'lab1', 'Lab Tech 1 (Moisture/Fineness)'],
        ['lab2', '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2', 'lab2', 'Lab Tech 2 (GCV/Ash)'],
        ['weighment', '612d15f5e3d7f9f473eedcd9325b55d321fa2ba1903b8a87826040510e8b451f', 'weighment', 'Weighment Operator'],
        ['moisture', '31bb9529338de24088742ffcdc2eadd5b35562e262c4b146a278287fc044210a', 'lab1m', 'Lab-1A Moisture Testing'],
        ['fineness', '1811fb31c01f83266818b662a87531d72502ed54860fdd625d92b1f4fcb7d340', 'lab1f', 'Lab-1B Fineness Testing'],
        ['unloading', 'b78cce73fc60f76e045ff6b3d4d0ac17ad360d4fd81617a2c3ec1039feae4313', 'unloading', 'After Weighment / Unloading Area']
    ];
    
    defaultUsers.forEach(function(u) {
        const found = existingUsers.some(function(ex) {
            return ex.username && ex.username.toLowerCase() === u[0].toLowerCase();
        });
        if (!found) {
            usersSheet.appendRow(u);
        }
    });

    if (usersSheet.getLastRow() > 1) {
        // Upgrade plaintext passwords if existing from older versions
        const numRows = usersSheet.getLastRow();
        const range = usersSheet.getRange(2, 1, numRows - 1, 2);
        const values = range.getValues();
        const defaults = {
            'admin': '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
            'entry': '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf',
            'lab1': '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609',
            'lab2': '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2',
            'weighment': '612d15f5e3d7f9f473eedcd9325b55d321fa2ba1903b8a87826040510e8b451f',
            'moisture': '31bb9529338de24088742ffcdc2eadd5b35562e262c4b146a278287fc044210a',
            'fineness': '1811fb31c01f83266818b662a87531d72502ed54860fdd625d92b1f4fcb7d340',
            'unloading': 'b78cce73fc60f76e045ff6b3d4d0ac17ad360d4fd81617a2c3ec1039feae4313'
        };
        
        let usernames = [];
        for (let i = 0; i < values.length; i++) {
            const username = values[i][0].toString().toLowerCase().trim();
            usernames.push(username);
            const password = values[i][1].toString();
            if (password.length !== 64 && defaults[username]) {
                usersSheet.getRange(i + 2, 2).setValue(defaults[username]);
            }
        }
        
        // Dynamically append weighment user if it does not exist yet in the Users sheet
        if (usernames.indexOf('weighment') === -1) {
            usersSheet.appendRow(['weighment', '612d15f5e3d7f9f473eedcd9325b55d321fa2ba1903b8a87826040510e8b451f', 'weighment', 'Weighment Operator']);
        }
    }

    getOrCreateSheet('ActivityLog', ['timestamp', 'username', 'action', 'details']);
}

function getOrCreateSheet(name, headers) {
    let sheet = DB.getSheetByName(name);
    if (!sheet) {
        sheet = DB.insertSheet(name);
        sheet.appendRow(headers);
    }
    return sheet;
}

// Convert a sheet row into a key-value object using headers
function getSheetRows(sheetName) {
    const sheet = DB.getSheetByName(name = sheetName);
    if (!sheet) return [];
    
    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length <= 1) return [];
    
    const headers = values[0];
    const rows = [];
    
    for (let i = 1; i < values.length; i++) {
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[i][j];
        }
        rows.push(row);
    }
    return rows;
}

// Append a row object to a sheet matching header column names dynamically
function appendRowByHeader(sheet, rowObject) {
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const newRow = [];
    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        let val = rowObject[header];
        if (val === undefined) {
            // Robust fallbacks for invoice/challan column variations
            if (header === 'invoice_no' || header === 'challan_no' || header === 'Challan No' || header === 'Challan No.') {
                val = rowObject.invoice_no || rowObject.challan_no || rowObject['Challan No'] || rowObject['Challan No.'] || '';
            } else {
                val = '';
            }
        }
        newRow.push(val);
    }
    sheet.appendRow(newRow);
}

// Update specific fields of a row by matching header column names dynamically
function updateRowFields(sheet, rowIndex, fieldMap) {
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    for (let key in fieldMap) {
        const colIndex = headers.indexOf(key) + 1;
        if (colIndex > 0) {
            sheet.getRange(rowIndex, colIndex).setValue(fieldMap[key]);
        } else if (key === 'invoice_no' || key === 'challan_no') {
            // Also check alternate spellings
            const altKeys = ['invoice_no', 'challan_no', 'Challan No', 'Challan No.'];
            for (let k of altKeys) {
                const altColIdx = headers.indexOf(k) + 1;
                if (altColIdx > 0) {
                    sheet.getRange(rowIndex, altColIdx).setValue(fieldMap[key]);
                }
            }
        }
    }
}

// Find a row index matching a column key, safe against empty sheets
function findRowIndex(sheet, colHeader, value) {
    if (!sheet) return -1;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow <= 1 || lastCol === 0) return -1;
    
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const colIndex = headers.indexOf(colHeader) + 1;
    if (colIndex === 0) return -1;
    
    const data = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
    for (let i = 0; i < data.length; i++) {
        if (data[i][0].toString() === value.toString()) {
            return i + 2; // 1-based index adjusted for header
        }
    }
    return -1;
}

// Helper to return JSON responses (Google Apps Script automatically handles CORS headers for Web App outputs)
function jsonResponse(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

// Helper to format Date objects as YYYY-MM-DD string in Apps Script timezone
function formatSheetDate(dateVal) {
    if (!dateVal) return '';
    if (dateVal instanceof Date) {
        return Utilities.formatDate(dateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
    return dateVal.toString().substring(0, 10);
}

// ================= ================= =================
// GET ROUTER (Retrievals)
// ================= ================= =================
function doGet(e) {
    initializeDatabase();
    const action = e.parameter.action;
    
    try {
        if (action === 'ping') {
            return jsonResponse({ success: true, message: 'Pong! Google Sheets Database connection is active.' });
        }
        
        if (action === 'login') {
            const username = e.parameter.username.toLowerCase().trim();
            const hashedPassword = e.parameter.hashedPassword;
            
            const cache = CacheService.getScriptCache();
            const lockoutKey = 'lockout_' + username;
            const attemptsKey = 'attempts_' + username;
            
            const isLocked = cache.get(lockoutKey);
            if (isLocked) {
                return jsonResponse({ success: false, message: 'Account is temporarily locked due to too many failed attempts. Please try again after 10 minutes.' });
            }
            
            const users = getSheetRows('Users');
            const user = users.find(u => u.username.toString().toLowerCase() === username);
            
            if (!user) {
                return jsonResponse({ success: false, message: 'Invalid username or password' });
            }
            
            if (user.password.toString() === hashedPassword) {
                cache.remove(attemptsKey);
                return jsonResponse({
                    success: true,
                    user: { username: user.username, role: user.role, name: user.name }
                });
            } else {
                let attempts = Number(cache.get(attemptsKey) || 0) + 1;
                if (attempts >= 5) {
                    cache.put(lockoutKey, 'true', 600);
                    cache.remove(attemptsKey);
                    return jsonResponse({ success: false, message: 'Too many failed login attempts. Your account has been locked for 10 minutes.' });
                } else {
                    cache.put(attemptsKey, attempts.toString(), 600);
                    return jsonResponse({ success: false, message: 'Invalid username or password. Remaining attempts before lockout: ' + (5 - attempts) });
                }
            }
        }
        
        
        if (action === 'getTrucks') {
            const role = e.parameter.role;
            if (role !== 'admin' && role !== 'lab2' && role !== 'weighment' && role !== 'entry' && role !== 'unloading') {
                return jsonResponse({ success: false, message: 'Unauthorized: Admin, Lab 2, Weighment, Entry, or Unloading role required.' });
            }
            const trucks = getSheetRows('Trucks');
            const lab1 = getSheetRows('Lab1Results');
            const mapped = trucks.map(function(t) {
                const res = lab1.find(function(r) { return r.sample1_barcode_id === t.sample1_barcode_id; });
                const moisture = res && res.moisture_pct !== '' && res.moisture_pct !== undefined && res.moisture_pct !== null ? Number(res.moisture_pct) : null;
                const status = moisture === null ? 'PENDING' : (moisture > 14 ? 'REJECTED' : 'ACCEPTED');
                return {
                    truck_id: t.truck_id,
                    entry_date: t.entry_date,
                    entry_time: t.entry_time,
                    company_name: t.company_name,
                    truck_reg_number: t.truck_reg_number,
                    driver_name: t.driver_name,
                    has_photo: !!(t.photo_url || t.driver_photo_url),
                    photo_url: (t.photo_url && t.photo_url.length < 500) ? t.photo_url : '',
                    invoice_no: t.invoice_no || t.challan_no || '',
                    challan_no: t.invoice_no || t.challan_no || '',
                    gross_weight: t.gross_weight,
                    tare_weight: t.tare_weight,
                    net_weight: status === 'REJECTED' ? 0 : t.net_weight,
                    sample1_barcode_id: t.sample1_barcode_id,
                    daily_group_code: t.daily_group_code,
                    moisture_pct: moisture,
                    acceptance_status: status
                };
            });
            return jsonResponse({ trucks: mapped });
        }
        
        if (action === 'getCompanies') {
            const trucks = getSheetRows('Trucks');
            const companies = [...new Set(trucks.map(t => t.company_name).filter(Boolean))];
            return jsonResponse({ companies: companies });
        }

        if (action === 'getComposites') {
            const role = e.parameter.role;
            if (role !== 'admin' && role !== 'lab2') {
                return jsonResponse({ success: false, message: 'Unauthorized: Admin or Lab 2 role required.' });
            }
            const batches = getSheetRows('CompositeBatches');
            return jsonResponse({ batches: batches });
        }

        if (action === 'getLab1Results') {
            const results = getSheetRows('Lab1Results');
            return jsonResponse({ results: results });
        }

        if (action === 'getDashboardData') {
            const trucks = getSheetRows('Trucks');
            const lab1Results = getSheetRows('Lab1Results');
            const composites = getSheetRows('CompositeBatches');
            return jsonResponse({
                trucks: trucks,
                lab1: lab1Results,
                composites: composites
            });
        }
        
        if (action === 'getSample1') {
            const barcodeId = e.parameter.barcodeId;
            const role = e.parameter.role;
            
            const trucks = getSheetRows('Trucks');
            const results = getSheetRows('Lab1Results');
            
            const truck = trucks.find(t => t.sample1_barcode_id === barcodeId);
            const result = results.find(r => r.sample1_barcode_id === barcodeId);
            
            if (!truck) {
                return jsonResponse({ success: false, message: 'Invalid barcode scanned.' });
            }
            
            // STRICT SECURITY BLIND FILTERING AT ENDPOINT
            if (role === 'lab1' || role === 'lab1m' || role === 'lab1f') {
                return jsonResponse({
                    success: true,
                    sample1_barcode_id: truck.sample1_barcode_id,
                    is_tested: !!result,
                    moisture_pct: result ? Number(result.moisture_pct) : null,
                    fineness_value: result ? Number(result.fineness_value) : null,
                    tested_at: result ? result.tested_at : null
                });
            } else {
                // Admin/Entry gets full details
                return jsonResponse({
                    success: true,
                    sample1_barcode_id: truck.sample1_barcode_id,
                    is_tested: !!result,
                    moisture_pct: result ? Number(result.moisture_pct) : null,
                    fineness_value: result ? Number(result.fineness_value) : null,
                    tested_at: result ? result.tested_at : null,
                    meta: {
                        truck_id: truck.truck_id,
                        company_name: truck.company_name,
                        truck_reg_number: truck.truck_reg_number
                    }
                });
            }
        }
        
        if (action === 'getLab1History') {
            const username = e.parameter.username;
            const results = getSheetRows('Lab1Results');
            const filtered = results.filter(r => r.tested_by.toString() === username);
            const mapped = filtered.map(r => ({
                sample1_barcode_id: r.sample1_barcode_id,
                tested_at: r.tested_at,
                moisture_pct: r.moisture_pct,
                fineness_value: r.fineness_value
            }));
            return jsonResponse(mapped);
        }
        
        if (action === 'getComposite') {
            const barcodeId = e.parameter.barcodeId;
            const role = e.parameter.role;
            
            const batches = getSheetRows('CompositeBatches');
            const rawInput = String(barcodeId || '').replace(/MIXING GROUP:/gi, '').replace(/GROUP:/gi, '').trim().toUpperCase();
            const coreCode = rawInput.replace(/[-_][RVT]$/i, '');

            const batch = batches.find(b => {
                const cRef = String(b.composite_ref_id || '').trim().toUpperCase();
                const cBar = String(b.composite_barcode_id || '').trim().toUpperCase();
                const cTest = String(b.test_lot || '').trim().toUpperCase();
                const cRefLot = String(b.referee_lot || '').trim().toUpperCase();
                const cVendLot = String(b.vendor_lot || '').trim().toUpperCase();
                const cGroup = String(b.daily_group_code || '').trim().toUpperCase();

                // Direct match
                if (rawInput === cRef || rawInput === cBar || rawInput === cTest || rawInput === cRefLot || rawInput === cVendLot || rawInput === cGroup) return true;
                if (coreCode === cRef || coreCode === cBar || coreCode === cTest || coreCode === cRefLot || coreCode === cVendLot || coreCode === cGroup) return true;

                // Substring & Core code match
                if (cRef && (rawInput.includes(cRef) || cRef.includes(coreCode) || coreCode.includes(cRef))) return true;
                if (cBar && (rawInput.includes(cBar) || cBar.includes(coreCode) || coreCode.includes(cBar))) return true;
                if (cGroup && (rawInput.includes(cGroup) || coreCode.includes(cGroup))) return true;

                return false;
            });
            
            if (!batch) {
                return jsonResponse({ success: false, message: 'Invalid composite barcode.' });
            }
            
            if (role === 'lab2') {
                const isTestLot = barcodeId.endsWith('-T') || barcodeId === batch.test_lot || barcodeId === batch.composite_barcode_id;
                if (!isTestLot) {
                    return jsonResponse({ success: false, message: 'Lab Station 2 can only process the Lab Testing Lot (-T) barcode. Referee and Vendor lots cannot be scanned for testing.' });
                }
            }
            
            // STRICT SECURITY BLIND FILTERING AT ENDPOINT
            if (role === 'lab2') {
                return jsonResponse({
                    success: true,
                    composite_barcode_id: batch.composite_barcode_id,
                    lot_type: barcodeId.endsWith('-R') ? 'Referee' : barcodeId.endsWith('-V') ? 'Vendor' : 'Test Lot',
                    is_tested: batch.gcv_value !== "" && batch.gcv_value !== null && batch.gcv_value !== undefined,
                    gcv_value: batch.gcv_value !== "" ? Number(batch.gcv_value) : null,
                    ash_pct: batch.ash_pct !== "" ? Number(batch.ash_pct) : null,
                    tested_at: batch.tested_at
                });
            } else {
                return jsonResponse({
                    success: true,
                    composite_barcode_id: batch.composite_barcode_id,
                    lot_type: barcodeId.endsWith('-R') ? 'Referee' : barcodeId.endsWith('-V') ? 'Vendor' : 'Test Lot',
                    is_tested: batch.gcv_value !== "" && batch.gcv_value !== null,
                    gcv_value: batch.gcv_value !== "" ? Number(batch.gcv_value) : null,
                    ash_pct: batch.ash_pct !== "" ? Number(batch.ash_pct) : null,
                    tested_at: batch.tested_at,
                    meta: {
                        company_name: batch.company_name,
                        date: batch.date
                    }
                });
            }
        }
        
        if (action === 'getLab2History') {
            const username = e.parameter.username;
            const batches = getSheetRows('CompositeBatches');
            const filtered = batches.filter(b => b.tested_by.toString() === username);
            const mapped = filtered.map(r => ({
                composite_barcode_id: r.composite_barcode_id,
                tested_at: r.tested_at,
                gcv_value: r.gcv_value,
                ash_pct: r.ash_pct
            }));
            return jsonResponse(mapped);
        }
        
        if (action === 'getAdminReport') {
            const role = e.parameter.role;
            if (role !== 'admin') {
                return jsonResponse({ success: false, message: 'Unauthorized: Admin role required.' });
            }
            const companyName = e.parameter.companyName;
            const date = e.parameter.date;
            
            const trucks = getSheetRows('Trucks');
            const lab1 = getSheetRows('Lab1Results');
            const composites = getSheetRows('CompositeBatches');
            
            const filteredTrucks = trucks.filter(t => t.company_name === companyName && formatSheetDate(t.entry_date) === date);
            
            const reportRows = filteredTrucks.map(truck => {
                const lab1Res = lab1.find(r => r.sample1_barcode_id === truck.sample1_barcode_id);
                const composite = composites.find(c => {
                    if (truck.composite_barcode_id && c.composite_barcode_id === truck.composite_barcode_id) return true;
                    const g1 = String(c.daily_group_code || '').trim().toUpperCase();
                    const g2 = String(truck.daily_group_code || '').trim().toUpperCase();
                    if (g1 && g2 && g1 === g2) return true;
                    if (c.parent_truck_ids) {
                        let parentIds = [];
                        try {
                            parentIds = typeof c.parent_truck_ids === 'string' ? JSON.parse(c.parent_truck_ids) : c.parent_truck_ids;
                        } catch(e) {}
                        if (Array.isArray(parentIds) && parentIds.includes(truck.truck_id)) return true;
                    }
                    return false;
                });
                
                const moistureVal = lab1Res && lab1Res.moisture_pct !== '' && lab1Res.moisture_pct !== undefined && lab1Res.moisture_pct !== null ? Number(lab1Res.moisture_pct) : null;
                const acceptance = evaluateAcceptance(moistureVal);
                
                let rejectionReason = '';
                if (acceptance === 'REJECTED') {
                    rejectionReason = moistureVal !== null ? `Moisture ${moistureVal}% > 14.0% Max Limit` : 'REJECTED';
                } else if (acceptance === 'ACCEPTED') {
                    rejectionReason = 'Passed (Moisture <= 14.0%)';
                } else {
                    rejectionReason = 'Pending Moisture Test';
                }

                const hasGcv = composite && composite.gcv_value !== "" && composite.gcv_value !== null && composite.gcv_value !== undefined;
                const hasAsh = composite && composite.ash_pct !== "" && composite.ash_pct !== null && composite.ash_pct !== undefined;

                return {
                    truck_id: truck.truck_id,
                    truck_reg_number: truck.truck_reg_number,
                    invoice_no: truck.invoice_no || '',
                    acceptance_status: acceptance,
                    rejection_reason: rejectionReason,
                    mixing_group_code: truck.daily_group_code || '',
                    driver_name: truck.driver_name,
                    entry_time: truck.entry_time,
                    photo_url: truck.photo_url || '',
                    gross_weight: Number(truck.gross_weight) || 0,
                    tare_weight: Number(truck.tare_weight) || 0,
                    net_weight: acceptance === 'REJECTED' ? 0 : (Number(truck.net_weight) || 0),
                    sample1_barcode: truck.sample1_barcode_id,
                    
                    moisture_pct: moistureVal,
                    fineness_value: lab1Res ? Number(lab1Res.fineness_value) : null,
                    
                    composite_barcode: acceptance === 'REJECTED' ? null : (composite ? (composite.composite_barcode_id || composite.composite_ref_id) : null),
                    gcv_value: acceptance === 'REJECTED' ? null : (hasGcv ? Number(composite.gcv_value) : null),
                    ash_pct: acceptance === 'REJECTED' ? null : (hasAsh ? Number(composite.ash_pct) : null)
                };
            });
            
            // Calculate aggregations
            let totalNet = 0;
            let sumMoisture = 0, countMoisture = 0;
            let sumFineness = 0, countFineness = 0;
            
            let acceptedCount = 0, rejectedCount = 0;
            reportRows.forEach(row => {
                if (row.acceptance_status === 'ACCEPTED') acceptedCount++;
                if (row.acceptance_status === 'REJECTED') rejectedCount++;
                totalNet += row.net_weight;
                if (row.moisture_pct !== null) {
                    sumMoisture += row.moisture_pct;
                    countMoisture++;
                }
                if (row.fineness_value !== null) {
                    sumFineness += row.fineness_value;
                    countFineness++;
                }
            });
            
            const uniqueComposites = [...new Set(reportRows.map(r => r.composite_barcode).filter(Boolean))];
            let sumGcv = 0, sumAsh = 0, countComp = 0;
            uniqueComposites.forEach(cId => {
                const comp = composites.find(b => b.composite_barcode_id === cId);
                if (comp && comp.gcv_value !== "") {
                    sumGcv += Number(comp.gcv_value);
                    sumAsh += Number(comp.ash_pct);
                    countComp++;
                }
            });
            
            return jsonResponse({
                company_name: companyName,
                date: date,
                rows: reportRows,
                summary: {
                    truck_count: reportRows.length,
                    accepted_count: acceptedCount,
                    rejected_count: rejectedCount,
                    total_net_weight: totalNet,
                    avg_moisture: countMoisture > 0 ? Number((sumMoisture / countMoisture).toFixed(2)) : null,
                    avg_fineness: countFineness > 0 ? Number((sumFineness / countFineness).toFixed(2)) : null,
                    avg_gcv: countComp > 0 ? Number((sumGcv / countComp).toFixed(0)) : null,
                    avg_ash: countComp > 0 ? Number((sumAsh / countComp).toFixed(2)) : null
                }
            });
        }
        
        if (action === 'getUnloadingStatus') {
            const role = e.parameter.role;
            if (role !== 'unloading' && role !== 'admin') {
                return jsonResponse({ success: false, message: 'Unauthorized: Unloading Area role required.' });
            }
            const barcodeId = e.parameter.barcodeId;
            const trucks = getSheetRows('Trucks');
            const lab1 = getSheetRows('Lab1Results');
            
            const truck = trucks.find(t => t.sample1_barcode_id === barcodeId || t.truck_id === barcodeId);
            if (!truck) {
                return jsonResponse({ success: false, message: 'No truck found for this code.' });
            }
            const res = lab1.find(r => r.sample1_barcode_id === truck.sample1_barcode_id);
            const moisture = res && res.moisture_pct !== '' && res.moisture_pct !== undefined && res.moisture_pct !== null ? Number(res.moisture_pct) : null;
            const status = evaluateAcceptance(moisture);
            
            const chVal = truck.invoice_no || truck.challan_no || truck['Challan No'] || truck['Challan No.'] || '';
            return jsonResponse({
                success: true,
                truck_id: truck.truck_id,
                truck_reg_number: truck.truck_reg_number,
                invoice_no: chVal,
                challan_no: chVal,
                company_name: truck.company_name,
                driver_name: truck.driver_name,
                daily_group_code: truck.daily_group_code || '',
                moisture_pct: moisture,
                fineness_value: res && res.fineness_value !== '' && res.fineness_value !== undefined && res.fineness_value !== null ? Number(res.fineness_value) : null,
                gross_weight: Number(truck.gross_weight) || 0,
                tare_weight: Number(truck.tare_weight) || 0,
                net_weight: status === 'REJECTED' ? 0 : (Number(truck.net_weight) || 0),
                acceptance_status: status,
                moisture_limit: MOISTURE_REJECT_LIMIT,
                unloading_allowed: status === 'ACCEPTED'
            });
        }
        
        if (action === 'getActivityLogs') {
            const logs = getSheetRows('ActivityLog');
            return jsonResponse({ success: true, logs: logs });
        }
        
        return jsonResponse({ success: false, message: 'Invalid Action' });
    } catch(err) {
        return jsonResponse({ success: false, message: err.toString() });
    }
}

// ================= ================= =================
// POST ROUTER (Submissions)
// ================= ================= =================
function doPost(e) {
    initializeDatabase();
    
    try {
        const postData = JSON.parse(e.postData.contents);
        const action = postData.action;
        
        if (action === 'login') {
            const username = postData.username.toLowerCase().trim();
            const hashedPassword = postData.hashedPassword;
            
            const cache = CacheService.getScriptCache();
            const lockoutKey = 'lockout_' + username;
            const attemptsKey = 'attempts_' + username;
            
            const isLocked = cache.get(lockoutKey);
            if (isLocked) {
                return jsonResponse({ success: false, message: 'Account is temporarily locked due to too many failed attempts. Please try again after 10 minutes.' });
            }
            
            const users = getSheetRows('Users');
            const user = users.find(u => u.username.toString().toLowerCase() === username);
            
            if (!user) {
                return jsonResponse({ success: false, message: 'Invalid username or password' });
            }
            
            if (user.password.toString() === hashedPassword) {
                cache.remove(attemptsKey);
                return jsonResponse({
                    success: true,
                    user: { username: user.username, role: user.role, name: user.name }
                });
            } else {
                let attempts = Number(cache.get(attemptsKey) || 0) + 1;
                if (attempts >= 5) {
                    cache.put(lockoutKey, 'true', 600);
                    cache.remove(attemptsKey);
                    return jsonResponse({ success: false, message: 'Too many failed login attempts. Your account has been locked for 10 minutes.' });
                } else {
                    cache.put(attemptsKey, attempts.toString(), 600);
                    return jsonResponse({ success: false, message: 'Invalid username or password. Remaining attempts before lockout: ' + (5 - attempts) });
                }
            }
        }
        
        if (action === 'registerTruck') {
            const sheet = DB.getSheetByName('Trucks');
            const data = postData.data;
            
            // Assign daily group code: respect client's calculated code or generate deterministically
            if (!data.daily_group_code) {
                const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
                const input = data.company_name.toLowerCase().trim() + "_" + data.entry_date;
                // Cryptographically secure deterministic hashing via SHA-256
                const rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
                
                // Convert first 4 bytes of SHA-256 hash to a positive 32-bit integer
                let val = 0;
                for (let i = 0; i < 4; i++) {
                    val = (val << 8) | (rawHash[i] & 0xFF);
                }
                val = Math.abs(val);
                
                let code = '';
                for (let i = 0; i < 3; i++) {
                    code += chars.charAt(val % chars.length);
                    val = Math.floor(val / chars.length);
                }
                data.daily_group_code = code;
            }
            
            appendRowByHeader(sheet, data);
            return jsonResponse({ success: true, daily_group_code: data.daily_group_code });
        }
        
        if (action === 'updateWeighment') {
            const sheet = DB.getSheetByName('Trucks');
            const rowIndex = findRowIndex(sheet, 'truck_id', postData.truckId);
            
            if (rowIndex > -1) {
                const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
                const statusIdx = headers.indexOf('acceptance_status');
                const grossIdx = headers.indexOf('gross_weight');
                const tareIdx = headers.indexOf('tare_weight');

                const role = postData.role || e.parameter.role;
                const existingGross = grossIdx > -1 ? sheet.getRange(rowIndex, grossIdx + 1).getValue() : 0;
                const existingTare = tareIdx > -1 ? sheet.getRange(rowIndex, tareIdx + 1).getValue() : 0;

                if (role === 'weighment' && existingGross !== '' && existingGross !== null && Number(existingGross) > 0) {
                    return jsonResponse({ success: false, message: 'Security Lock: Gross weight for this truck has already been locked and submitted.' });
                }
                if (role === 'unloading' && existingTare !== '' && existingTare !== null && Number(existingTare) > 0) {
                    return jsonResponse({ success: false, message: 'Security Lock: Final tare weight for this truck has already been locked and submitted.' });
                }

                let netWeight = postData.netWeight;
                if (statusIdx > -1) {
                    const currentStatus = sheet.getRange(rowIndex, statusIdx + 1).getValue();
                    if (currentStatus === 'REJECTED') netWeight = 0;
                }
                
                updateRowFields(sheet, rowIndex, {
                    gross_weight: (postData.grossWeight !== undefined && postData.grossWeight !== null && postData.grossWeight !== '') ? postData.grossWeight : existingGross,
                    tare_weight: (postData.tareWeight !== undefined && postData.tareWeight !== null && postData.tareWeight !== '') ? postData.tareWeight : existingTare,
                    net_weight: netWeight
                });
                return jsonResponse({ success: true, net_weight: netWeight });
            }
            return jsonResponse({ success: false, message: 'Truck ID not found' });
        }
        
        if (action === 'submitSample1') {
            const sheet = DB.getSheetByName('Lab1Results');
            const data = postData.data;
            
            const writeMoisture = (data.write_moisture !== false) && data.moisture_pct !== null && data.moisture_pct !== '' && data.moisture_pct !== undefined;
            const writeFineness = (data.write_fineness !== false) && data.fineness_value !== null && data.fineness_value !== '' && data.fineness_value !== undefined;
            
            const rowIndex = findRowIndex(sheet, 'sample1_barcode_id', data.sample1_barcode_id);
            let finalMoisture = null;
            
            if (rowIndex > -1) {
                if (writeMoisture) {
                    sheet.getRange(rowIndex, 2).setValue(data.moisture_pct);
                    setCellByHeader(sheet, rowIndex, 'moisture_by', data.tested_by);
                    setCellByHeader(sheet, rowIndex, 'moisture_at', data.tested_at);
                }
                if (writeFineness) {
                    sheet.getRange(rowIndex, 3).setValue(data.fineness_value);
                    setCellByHeader(sheet, rowIndex, 'fineness_by', data.tested_by);
                    setCellByHeader(sheet, rowIndex, 'fineness_at', data.tested_at);
                }
                sheet.getRange(rowIndex, 4).setValue(data.tested_by);
                sheet.getRange(rowIndex, 5).setValue(data.tested_at);
                finalMoisture = sheet.getRange(rowIndex, 2).getValue();
            } else {
                sheet.appendRow([
                    data.sample1_barcode_id,
                    writeMoisture ? data.moisture_pct : '',
                    writeFineness ? data.fineness_value : '',
                    data.tested_by,
                    data.tested_at,
                    writeMoisture ? data.tested_by : '',
                    writeMoisture ? data.tested_at : '',
                    writeFineness ? data.tested_by : '',
                    writeFineness ? data.tested_at : ''
                ]);
                finalMoisture = writeMoisture ? data.moisture_pct : '';
            }
            
            // ===== AUTOMATIC ACCEPTANCE / REJECTION =====
            const status = evaluateAcceptance(finalMoisture);
            const trucksSheet = DB.getSheetByName('Trucks');
            const tRow = findRowIndex(trucksSheet, 'sample1_barcode_id', data.sample1_barcode_id);
            if (tRow > -1) {
                setCellByHeader(trucksSheet, tRow, 'acceptance_status', status);
                if (status === 'REJECTED') {
                    trucksSheet.getRange(tRow, 10).setValue(0);
                } else if (status === 'ACCEPTED') {
                    const gross = Number(trucksSheet.getRange(tRow, 8).getValue()) || 0;
                    const tare = Number(trucksSheet.getRange(tRow, 9).getValue()) || 0;
                    if (gross && tare) trucksSheet.getRange(tRow, 10).setValue(gross - tare);
                }
            }
            
            return jsonResponse({ success: true, acceptance_status: status, moisture_limit: MOISTURE_REJECT_LIMIT });
        }
        
        if (action === 'createComposite') {
            const sheet = DB.getSheetByName('CompositeBatches');
            const data = postData.data;

            // Check if batch already exists by composite_ref_id or daily_group_code to prevent duplicate sheet rows
            const existingIdx = findRowIndex(sheet, 'composite_ref_id', data.composite_ref_id);
            if (existingIdx > -1) {
                return jsonResponse({ success: true, already_exists: true, message: 'Existing composite batch retained.' });
            }
            if (data.daily_group_code) {
                const groupIdx = findRowIndex(sheet, 'daily_group_code', data.daily_group_code);
                if (groupIdx > -1) {
                    return jsonResponse({ success: true, already_exists: true, message: 'Composite barcodes already exist for this Group Code.' });
                }
            }

            sheet.appendRow([
                data.composite_ref_id,
                data.composite_barcode_id,
                data.company_name,
                data.date,
                JSON.stringify(data.parent_truck_ids),
                '', 
                '', 
                '', 
                '', 
                data.lots.test,
                data.lots.referee,
                data.lots.vendor,
                data.system_samples_count || 0,
                data.mixed_samples_count || 0,
                data.daily_group_code || ''
            ]);
            
            const trucksSheet = DB.getSheetByName('Trucks');
            const parentTruckIds = data.parent_truck_ids;
            parentTruckIds.forEach(tId => {
                const rIndex = findRowIndex(trucksSheet, 'truck_id', tId);
                if (rIndex > -1) {
                    trucksSheet.getRange(rIndex, 12).setValue(data.composite_barcode_id);
                }
            });
            
            return jsonResponse({ success: true });
        }
        
        if (action === 'submitComposite') {
            const sheet = DB.getSheetByName('CompositeBatches');
            const targetId = String(postData.compositeBarcodeId || '').trim();
            
            let rowIndex = findRowIndex(sheet, 'composite_barcode_id', targetId);
            if (rowIndex === -1) {
                rowIndex = findRowIndex(sheet, 'composite_ref_id', targetId);
            }
            if (rowIndex === -1) {
                rowIndex = findRowIndex(sheet, 'test_lot', targetId);
            }
            if (rowIndex === -1) {
                // Multi-pass scan across all rows if header lookup returned -1
                const data = sheet.getDataRange().getValues();
                const cleanTarget = targetId.toUpperCase();
                for (let i = 1; i < data.length; i++) {
                    const rowStr = data[i].join(' ').toUpperCase();
                    if (rowStr.includes(cleanTarget)) {
                        rowIndex = i + 1;
                        break;
                    }
                }
            }
            
            if (rowIndex > -1) {
                sheet.getRange(rowIndex, 6).setValue(postData.gcv);
                sheet.getRange(rowIndex, 7).setValue(postData.ash);
                sheet.getRange(rowIndex, 8).setValue(postData.testedBy);
                sheet.getRange(rowIndex, 9).setValue(postData.testedAt);
                return jsonResponse({ success: true });
            }
            return jsonResponse({ success: false, message: 'Composite ID not found' });
        }
        
        if (action === 'updateRefereeChallenge') {
            const sheet = DB.getSheetByName('CompositeBatches');
            const targetId = String(postData.compositeRefId || postData.compositeBarcodeId || '').trim();
            
            let rowIndex = findRowIndex(sheet, 'composite_ref_id', targetId);
            if (rowIndex === -1) rowIndex = findRowIndex(sheet, 'composite_barcode_id', targetId);
            if (rowIndex === -1) rowIndex = findRowIndex(sheet, 'daily_group_code', targetId);
            if (rowIndex === -1) {
                const data = sheet.getDataRange().getValues();
                const cleanTarget = targetId.toUpperCase();
                for (let i = 1; i < data.length; i++) {
                    const rowStr = data[i].join(' ').toUpperCase();
                    if (rowStr.includes(cleanTarget)) {
                        rowIndex = i + 1;
                        break;
                    }
                }
            }

            if (rowIndex > -1) {
                if (postData.vendorGcv !== undefined && postData.vendorGcv !== null && postData.vendorGcv !== '') {
                    setCellByHeader(sheet, rowIndex, 'vendor_gcv', postData.vendorGcv);
                }
                if (postData.refereeGcv !== undefined && postData.refereeGcv !== null && postData.refereeGcv !== '') {
                    setCellByHeader(sheet, rowIndex, 'referee_gcv', postData.refereeGcv);
                }
                if (postData.refereeStatus !== undefined && postData.refereeStatus !== null && postData.refereeStatus !== '') {
                    setCellByHeader(sheet, rowIndex, 'referee_status', postData.refereeStatus);
                }
                setCellByHeader(sheet, rowIndex, 'referee_updated_at', new Date().toISOString().replace('T', ' ').substring(0, 16));
                return jsonResponse({ success: true });
            }
            return jsonResponse({ success: false, message: 'Composite lot not found in CompositeBatches sheet.' });
        }
        
        if (action === 'logActivity') {
            const sheet = DB.getSheetByName('ActivityLog');
            const log = postData.log;
            sheet.appendRow([
                log.timestamp,
                log.username,
                log.action,
                log.details
            ]);
            return jsonResponse({ success: true });
        }
        
        return jsonResponse({ success: false, message: 'Invalid Action' });
    } catch(err) {
        return jsonResponse({ success: false, message: err.toString() });
    }
}
