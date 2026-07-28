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

// Auto-initialize sheets and headers if they do not exist
function initializeDatabase() {
    const trucksSheet = getOrCreateSheet('Trucks', [
        'truck_id', 'company_name', 'driver_name', 'truck_reg_number', 'entry_date', 'entry_time', 
        'photo_url', 'gross_weight', 'tare_weight', 'net_weight', 'sample1_barcode_id', 
        'composite_barcode_id', 'created_by', 'daily_group_code'
    ]);
    
    // Ensure daily_group_code column is added to existing spreadsheets if missing
    const lastCol = trucksSheet.getLastColumn();
    if (lastCol > 0) {
        const headers = trucksSheet.getRange(1, 1, 1, lastCol).getValues()[0];
        if (headers.indexOf('daily_group_code') === -1) {
            trucksSheet.getRange(1, lastCol + 1).setValue('daily_group_code');
        }
    }
    
    getOrCreateSheet('Lab1Results', [
        'sample1_barcode_id', 'moisture_pct', 'fineness_value', 'tested_by', 'tested_at'
    ]);
    
    const compositeSheet = getOrCreateSheet('CompositeBatches', [
        'composite_ref_id', 'composite_barcode_id', 'company_name', 'date', 'parent_truck_ids', 
        'gcv_value', 'ash_pct', 'tested_by', 'tested_at', 'test_lot', 'referee_lot', 'vendor_lot',
        'system_samples_count', 'mixed_samples_count'
    ]);
    
    // Ensure audit columns exist in existing spreadsheets if missing
    const lastCompCol = compositeSheet.getLastColumn();
    if (lastCompCol > 0) {
        const headers = compositeSheet.getRange(1, 1, 1, lastCompCol).getValues()[0];
        if (headers.indexOf('system_samples_count') === -1) {
            compositeSheet.getRange(1, lastCompCol + 1).setValue('system_samples_count');
            compositeSheet.getRange(1, lastCompCol + 2).setValue('mixed_samples_count');
        }
    }
    
    const usersSheet = getOrCreateSheet('Users', ['username', 'password', 'role', 'name']);
    if (usersSheet.getLastRow() <= 1) {
        usersSheet.appendRow(['admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin', 'System Administrator']);
        usersSheet.appendRow(['entry', '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf', 'entry', 'Entry Gate Operator']);
        usersSheet.appendRow(['lab1', '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609', 'lab1', 'Lab Tech 1 (Moisture/Fineness)']);
        usersSheet.appendRow(['lab2', '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2', 'lab2', 'Lab Tech 2 (GCV/Ash)']);
    } else {
        // Upgrade plaintext passwords if existing from older versions
        const numRows = usersSheet.getLastRow();
        const range = usersSheet.getRange(2, 1, numRows - 1, 2);
        const values = range.getValues();
        const defaults = {
            'admin': '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
            'entry': '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf',
            'lab1': '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609',
            'lab2': '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2'
        };
        for (let i = 0; i < values.length; i++) {
            const username = values[i][0].toString().toLowerCase().trim();
            const password = values[i][1].toString();
            if (password.length !== 64 && defaults[username]) {
                usersSheet.getRange(i + 2, 2).setValue(defaults[username]);
            }
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
        
        
        if (action === 'getTrucks') {
            const role = e.parameter.role;
            if (role !== 'admin' && role !== 'lab2') {
                return jsonResponse({ success: false, message: 'Unauthorized: Admin or Lab 2 role required.' });
            }
            const trucks = getSheetRows('Trucks');
            return jsonResponse({ trucks: trucks });
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
            if (role === 'lab1') {
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
            const batch = batches.find(b => 
                b.composite_barcode_id === barcodeId || 
                b.test_lot === barcodeId || 
                b.referee_lot === barcodeId || 
                b.vendor_lot === barcodeId
            );
            
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
                const composite = composites.find(c => c.composite_barcode_id === truck.composite_barcode_id);
                
                return {
                    truck_id: truck.truck_id,
                    truck_reg_number: truck.truck_reg_number,
                    driver_name: truck.driver_name,
                    entry_time: truck.entry_time,
                    photo_url: truck.photo_url || '',
                    gross_weight: Number(truck.gross_weight) || 0,
                    tare_weight: Number(truck.tare_weight) || 0,
                    net_weight: Number(truck.net_weight) || 0,
                    sample1_barcode: truck.sample1_barcode_id,
                    
                    moisture_pct: lab1Res ? Number(lab1Res.moisture_pct) : null,
                    fineness_value: lab1Res ? Number(lab1Res.fineness_value) : null,
                    
                    composite_barcode: composite ? composite.composite_barcode_id : null,
                    gcv_value: composite && composite.gcv_value !== "" ? Number(composite.gcv_value) : null,
                    ash_pct: composite && composite.ash_pct !== "" ? Number(composite.ash_pct) : null
                };
            });
            
            // Calculate aggregations
            let totalNet = 0;
            let sumMoisture = 0, countMoisture = 0;
            let sumFineness = 0, countFineness = 0;
            
            reportRows.forEach(row => {
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
                    total_net_weight: totalNet,
                    avg_moisture: countMoisture > 0 ? Number((sumMoisture / countMoisture).toFixed(2)) : null,
                    avg_fineness: countFineness > 0 ? Number((sumFineness / countFineness).toFixed(2)) : null,
                    avg_gcv: countComp > 0 ? Number((sumGcv / countComp).toFixed(0)) : null,
                    avg_ash: countComp > 0 ? Number((sumAsh / countComp).toFixed(2)) : null
                }
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
                let hash = 0;
                for (let i = 0; i < input.length; i++) {
                    hash = ((hash << 5) - hash) + input.charCodeAt(i);
                    hash = hash & hash;
                }
                let val = Math.abs(hash);
                let code = '';
                for (let i = 0; i < 3; i++) {
                    code += chars.charAt(val % chars.length);
                    val = Math.floor(val / chars.length);
                }
                data.daily_group_code = code;
            }
            
            sheet.appendRow([
                data.truck_id,
                data.company_name,
                data.driver_name,
                data.truck_reg_number,
                data.entry_date,
                data.entry_time,
                data.photo_url,
                data.gross_weight,
                data.tare_weight,
                data.net_weight,
                data.sample1_barcode_id,
                data.composite_barcode_id,
                data.created_by,
                data.daily_group_code
            ]);
            return jsonResponse({ success: true, daily_group_code: groupCode });
        }
        
        if (action === 'updateWeighment') {
            const sheet = DB.getSheetByName('Trucks');
            const rowIndex = findRowIndex(sheet, 'truck_id', postData.truckId);
            
            if (rowIndex > -1) {
                sheet.getRange(rowIndex, 8).setValue(postData.grossWeight);
                sheet.getRange(rowIndex, 9).setValue(postData.tareWeight);
                sheet.getRange(rowIndex, 10).setValue(postData.netWeight);
                return jsonResponse({ success: true });
            }
            return jsonResponse({ success: false, message: 'Truck ID not found' });
        }
        
        if (action === 'submitSample1') {
            const sheet = DB.getSheetByName('Lab1Results');
            const data = postData.data;
            
            const rowIndex = findRowIndex(sheet, 'sample1_barcode_id', data.sample1_barcode_id);
            if (rowIndex > -1) {
                sheet.getRange(rowIndex, 2).setValue(data.moisture_pct);
                sheet.getRange(rowIndex, 3).setValue(data.fineness_value);
                sheet.getRange(rowIndex, 4).setValue(data.tested_by);
                sheet.getRange(rowIndex, 5).setValue(data.tested_at);
            } else {
                sheet.appendRow([
                    data.sample1_barcode_id,
                    data.moisture_pct,
                    data.fineness_value,
                    data.tested_by,
                    data.tested_at
                ]);
            }
            return jsonResponse({ success: true });
        }
        
        if (action === 'createComposite') {
            const sheet = DB.getSheetByName('CompositeBatches');
            const data = postData.data;
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
                data.mixed_samples_count || 0
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
            const rowIndex = findRowIndex(sheet, 'composite_barcode_id', postData.compositeBarcodeId);
            
            if (rowIndex > -1) {
                sheet.getRange(rowIndex, 6).setValue(postData.gcv);
                sheet.getRange(rowIndex, 7).setValue(postData.ash);
                sheet.getRange(rowIndex, 8).setValue(postData.testedBy);
                sheet.getRange(rowIndex, 9).setValue(postData.testedAt);
                return jsonResponse({ success: true });
            }
            return jsonResponse({ success: false, message: 'Composite ID not found' });
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
