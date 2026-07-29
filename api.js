/**
 * Biomass Sampling - Data Access & Security Layer (api.js)
 * Enforces role-based access control and sanitizes responses for Lab Technicians and Gate Operators.
 * Integrates directly with the Google Sheets REST API.
 */
(function() {
    const STORAGE_KEY = 'BIOMASS_DB_STATE';
    const CONFIG_KEY = 'BIOMASS_CONFIG';

    // Default User Accounts (stored as SHA-256 hashes)
    const DEFAULT_USERS = [
        { username: 'admin', password: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', role: 'admin', name: 'System Administrator' },
        { username: 'entry', password: '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf', role: 'entry', name: 'Entry Gate Operator' },
        { username: 'weighment', password: '612d15f5e3d7f9f473eedcd9325b55d321fa2ba1903b8a87826040510e8b451f', role: 'weighment', name: 'Weighment Operator' },
        { username: 'lab1', password: '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609', role: 'lab1', name: 'Lab Tech 1 (Moisture/Fineness)' },
        { username: 'lab2', password: '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2', role: 'lab2', name: 'Lab Tech 2 (GCV/Ash)' }
    ];

    // Initial state is COMPLETELY EMPTY. No mock demo data.
    const DEFAULT_DATA = {
        trucks: [],
        lab1_results: [],
        composite_batches: [],
        companies: []
    };

    // Helper to generate secure random opaque tokens for barcodes
    function generateOpaqueId(prefix) {
        const chars = '0123456789ABCDEF';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
        return `${prefix}-${result}`;
    }

    // Initialize Database
    function getDB() {
        let db = localStorage.getItem(STORAGE_KEY);
        if (!db) {
            db = JSON.stringify(DEFAULT_DATA);
            localStorage.setItem(STORAGE_KEY, db);
        }
        return JSON.parse(db);
    }

    function saveDB(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    // Config (Google Apps Script URL)
    function getConfig() {
        const defaultUrl = 'https://script.google.com/macros/s/AKfycbwr__Y-G_hnHOTT-NFwTq6naGDsk8x-52E4jcF6JqEqSovLqhnmdZxxilJgNy3a7y6e/exec';
        let config = localStorage.getItem(CONFIG_KEY);
        if (!config) {
            config = JSON.stringify({ appsScriptUrl: defaultUrl });
            localStorage.setItem(CONFIG_KEY, config);
        }
        let parsed = JSON.parse(config);
        // Force override if blank from older runs or if it contains the old template placeholder URL
        if (!parsed.appsScriptUrl || parsed.appsScriptUrl === '' || parsed.appsScriptUrl.includes('AKfycbUp9Wk30GS3QOqy')) {
            parsed.appsScriptUrl = defaultUrl;
            localStorage.setItem(CONFIG_KEY, JSON.stringify(parsed));
        }
        return parsed;
    }

    function saveConfig(config) {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    }

    // Helper: secure role checker
    function getActiveUserRole() {
        const user = window.BiomassAPI.getCurrentUser();
        return user ? user.role : null;
    }

    // Central API Object
    window.BiomassAPI = {
        // ================= TIMEZONE-SAFE DATE FORMATTERS =================
        formatLocalYYYYMMDD: function(dateVal) {
            if (!dateVal) return '';
            try {
                const d = new Date(dateVal);
                if (isNaN(d.getTime())) return dateVal.toString().substring(0, 10);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            } catch (e) {
                return dateVal.toString().substring(0, 10);
            }
        },

        formatLocalTime: function(timeVal) {
            if (!timeVal) return '';
            try {
                const d = new Date(timeVal);
                if (isNaN(d.getTime())) return timeVal.toString();
                const hrs = String(d.getHours()).padStart(2, '0');
                const mins = String(d.getMinutes()).padStart(2, '0');
                const secs = String(d.getSeconds()).padStart(2, '0');
                return `${hrs}:${mins}:${secs}`;
            } catch(e) {
                return timeVal.toString();
            }
        },

        // ================= CONFIG & AUTH =================
        setAppsScriptUrl: function(url) {
            const config = getConfig();
            config.appsScriptUrl = url;
            saveConfig(config);
        },

        getAppsScriptUrl: function() {
            return getConfig().appsScriptUrl;
        },

        isRemoteMode: function() {
            const url = this.getAppsScriptUrl();
            return !!url && url.startsWith('http');
        },

        getCurrentUser: function() {
            const session = sessionStorage.getItem('BIOMASS_SESSION');
            return session ? JSON.parse(session) : null;
        },

        login: async function(username, hashedPassword) {
            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'login',
                            username: username,
                            hashedPassword: hashedPassword
                        })
                    });
                    const res = await response.json();
                    if (res.success) {
                        const sessionUser = { username: res.user.username, role: res.user.role, name: res.user.name };
                        sessionStorage.setItem('BIOMASS_SESSION', JSON.stringify(sessionUser));
                        return { success: true, user: sessionUser };
                    }
                    return { success: false, message: res.message || 'Invalid username or password' };
                } catch (e) {
                    console.error('Remote login failed:', e);
                    throw new Error('Connection failed: ' + e.message);
                }
            }

            const user = DEFAULT_USERS.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === hashedPassword);
            if (user) {
                const sessionUser = { username: user.username, role: user.role, name: user.name };
                sessionStorage.setItem('BIOMASS_SESSION', JSON.stringify(sessionUser));
                return { success: true, user: sessionUser };
            }
            return { success: false, message: 'Invalid username or password' };
        },

        logout: function() {
            sessionStorage.removeItem('BIOMASS_SESSION');
        },

        // ================= INTAKE: TRUCK REGISTRATION & WEIGHMENT =================
        registerTruck: async function(truckData) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'entry')) {
                throw new Error('Unauthorized: Admin or Entry access required');
            }

            // Helper to generate deterministic daily group code
            function getDailyGroupCode(companyName, dateString) {
                const input = companyName.toLowerCase().trim() + "_" + dateString;
                let hash = 0;
                for (let i = 0; i < input.length; i++) {
                    const char = input.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash;
                }
                const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
                let val = Math.abs(hash);
                let code = '';
                for (let i = 0; i < 3; i++) {
                    code += chars.charAt(val % chars.length);
                    val = Math.floor(val / chars.length);
                }
                return code;
            }

            let entryDate = truckData.entry_date;
            if (!entryDate) {
                const localDate = new Date();
                const year = localDate.getFullYear();
                const month = String(localDate.getMonth() + 1).padStart(2, '0');
                const day = String(localDate.getDate()).padStart(2, '0');
                entryDate = `${year}-${month}-${day}`;
            }
            const groupCode = getDailyGroupCode(truckData.company_name, entryDate);

            const newTruck = {
                truck_id: `TRK-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
                company_name: truckData.company_name,
                driver_name: truckData.driver_name,
                truck_reg_number: truckData.truck_reg_number,
                entry_date: entryDate,
                entry_time: truckData.entry_time || new Date().toTimeString().split(' ')[0].substring(0, 5),
                photo_url: truckData.photo_url || '',
                gross_weight: Number(truckData.gross_weight) || 0,
                tare_weight: Number(truckData.tare_weight) || 0,
                net_weight: 0,
                sample1_barcode_id: generateOpaqueId('S1'),
                composite_barcode_id: '',
                created_by: user.username,
                daily_group_code: groupCode
            };

            if (newTruck.gross_weight && newTruck.tare_weight) {
                newTruck.net_weight = newTruck.gross_weight - newTruck.tare_weight;
            }

            if (this.isRemoteMode()) {
                try {
                    // Using mode: 'no-cors' for POST inserts. This bypasses the Google Redirect CORS policy blockage
                    // and resolves successfully on data write.
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({ action: 'registerTruck', data: newTruck })
                    });
                } catch (e) {
                    console.error('Remote save failed:', e);
                    throw new Error('Google Sheets synchronization failed. Details: ' + e.message);
                }
            } else {
                const db = getDB();
                db.trucks.push(newTruck);
                if (!db.companies.includes(newTruck.company_name)) {
                    db.companies.push(newTruck.company_name);
                }
                saveDB(db);
            }

            return newTruck;
        },

        getTrucks: async function() {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'lab2' && user.role !== 'weighment' && user.role !== 'entry')) {
                throw new Error('Unauthorized: Admin, Lab 2, Weighment, or Entry access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getTrucks&role=${user.role}`);
                    const data = await response.json();
                    return data.trucks || [];
                } catch (e) {
                    console.error('Remote getTrucks failed:', e);
                    throw new Error('Google Sheets sync failed. Please check your Web App URL in settings. Details: ' + e.message);
                }
            }

            const db = getDB();
            return db.trucks;
        },

        updateWeighment: async function(truckId, grossWeight, tareWeight) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'weighment')) {
                throw new Error('Unauthorized: Admin or Weighment access required');
            }

            grossWeight = Number(grossWeight) || 0;
            tareWeight = Number(tareWeight) || 0;
            const netWeight = (grossWeight && tareWeight) ? (grossWeight - tareWeight) : 0;

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'updateWeighment',
                            truckId,
                            grossWeight,
                            tareWeight,
                            netWeight
                        })
                    });
                } catch (e) {
                    console.error('Remote updateWeighment failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            } else {
                const db = getDB();
                const truck = db.trucks.find(t => t.truck_id === truckId);
                if (truck) {
                    truck.gross_weight = grossWeight;
                    truck.tare_weight = tareWeight;
                    truck.net_weight = netWeight;
                    saveDB(db);
                } else {
                    return { success: false, message: 'Truck ID not found' };
                }
            }

            return { success: true };
        },

        getCompanies: async function() {
            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getCompanies`);
                    const data = await response.json();
                    return data.companies || [];
                } catch (e) {
                    console.error('Remote getCompanies failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }
            return getDB().companies;
        },

        // ================= LAB 1: MOISTURE & FINENESS TESTING (STRICT BLIND) =================
        getSample1Details: async function(barcodeId) {
            const role = getActiveUserRole();
            if (!role) {
                throw new Error('Unauthorized: Please login first');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getSample1&barcodeId=${encodeURIComponent(barcodeId)}&role=${role}`);
                    return await response.json();
                } catch (e) {
                    console.error('Remote getSample1Details failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const truck = db.trucks.find(t => t.sample1_barcode_id === barcodeId);
            const result = db.lab1_results.find(r => r.sample1_barcode_id === barcodeId);

            if (!truck) {
                return { success: false, message: 'Invalid barcode scanned.' };
            }

            if (role === 'lab1') {
                return {
                    success: true,
                    sample1_barcode_id: truck.sample1_barcode_id,
                    is_tested: !!result,
                    moisture_pct: result ? result.moisture_pct : null,
                    fineness_value: result ? result.fineness_value : null,
                    tested_at: result ? result.tested_at : null
                };
            } else if (role === 'admin') {
                return {
                    success: true,
                    sample1_barcode_id: truck.sample1_barcode_id,
                    is_tested: !!result,
                    moisture_pct: result ? result.moisture_pct : null,
                    fineness_value: result ? result.fineness_value : null,
                    tested_at: result ? result.tested_at : null,
                    meta: {
                        truck_id: truck.truck_id,
                        company_name: truck.company_name,
                        truck_reg_number: truck.truck_reg_number
                    }
                };
            }

            throw new Error('Unauthorized: Invalid role for Sample 1 lookup');
        },

        submitSample1Result: async function(barcodeId, moisture, fineness) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'lab1' && user.role !== 'admin')) {
                throw new Error('Unauthorized: Lab 1 or Admin access required');
            }

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
            const record = {
                sample1_barcode_id: barcodeId,
                moisture_pct: Number(moisture),
                fineness_value: Number(fineness),
                tested_by: user.username,
                tested_at: timestamp
            };

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'submitSample1',
                            data: record
                        })
                    });
                } catch (e) {
                    console.error('Remote submitSample1 failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            } else {
                const db = getDB();
                const truckExists = db.trucks.some(t => t.sample1_barcode_id === barcodeId);
                if (!truckExists) {
                    return { success: false, message: 'Invalid barcode. Truck entry not found.' };
                }

                const existingIndex = db.lab1_results.findIndex(r => r.sample1_barcode_id === barcodeId);
                if (existingIndex > -1) {
                    db.lab1_results[existingIndex] = record;
                } else {
                    db.lab1_results.push(record);
                }
                saveDB(db);
            }
            return { success: true, record };
        },

        getLab1History: async function() {
            const user = this.getCurrentUser();
            if (!user) throw new Error('Not logged in');

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getLab1History&username=${user.username}`);
                    return await response.json();
                } catch (e) {
                    console.error('Remote getLab1History failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const results = user.role === 'admin' 
                ? db.lab1_results 
                : db.lab1_results.filter(r => r.tested_by === user.username);
            
            return results.map(r => ({
                sample1_barcode_id: r.sample1_barcode_id,
                tested_at: r.tested_at,
                moisture_pct: r.moisture_pct,
                fineness_value: r.fineness_value
            }));
        },

        // ================= COMPOSITE MIXING (ADMIN) =================
        createCompositeBatch: async function(companyName, date, parentTruckIds, systemCount, mixedCount) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'lab2')) {
                throw new Error('Unauthorized: Admin or Lab 2 access required');
            }

            if (!parentTruckIds || parentTruckIds.length === 0) {
                return { success: false, message: 'No trucks selected for mixing.' };
            }

            const refId = `CMP-${date.replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
            const newBatch = {
                composite_ref_id: refId,
                composite_barcode_id: `${refId}-T`, 
                company_name: companyName,
                date: date,
                parent_truck_ids: parentTruckIds,
                gcv_value: null,
                ash_pct: null,
                tested_by: '',
                tested_at: '',
                lots: {
                    test: `${refId}-T`,
                    referee: `${refId}-R`,
                    vendor: `${refId}-V`
                },
                system_samples_count: Number(systemCount) || parentTruckIds.length,
                mixed_samples_count: Number(mixedCount) || parentTruckIds.length
            };

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'createComposite',
                            data: newBatch
                        })
                    });
                } catch (e) {
                    console.error('Remote createComposite failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            } else {
                const db = getDB();
                db.composite_batches.push(newBatch);
                parentTruckIds.forEach(tId => {
                    const truck = db.trucks.find(t => t.truck_id === tId);
                    if (truck) {
                        truck.composite_barcode_id = newBatch.composite_barcode_id;
                    }
                });
                saveDB(db);
            }

            return { success: true, batch: newBatch };
        },

        generateCompositeFromGroup: async function(groupCode, mixedCount) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'lab2')) {
                throw new Error('Unauthorized: Admin or Lab 2 access required');
            }
            
            const trucks = await this.getTrucks();
            const todayStr = this.formatLocalYYYYMMDD(new Date());
            
            const groupTrucks = trucks.filter(t => {
                const normalizedDate = this.formatLocalYYYYMMDD(t.entry_date);
                return t.daily_group_code === groupCode && normalizedDate === todayStr;
            });
            
            if (groupTrucks.length === 0) {
                throw new Error(`No trucks registered today under Group Code: ${groupCode}`);
            }
            
            const companyName = groupTrucks[0].company_name;
            const parentTruckIds = groupTrucks.map(t => t.truck_id);
            
            let batches = [];
            if (this.isRemoteMode()) {
                const response = await fetch(`${this.getAppsScriptUrl()}?action=getComposites&role=${user.role}`);
                const data = await response.json();
                batches = data.batches || [];
            } else {
                batches = getDB().composite_batches;
            }
            
            const existing = batches.find(b => b.company_name === companyName && b.date === todayStr);
            if (existing) {
                return { success: false, message: `Barcodes already generated for the Mixing Group Code: ${groupCode} today.` };
            }
            
            return await this.createCompositeBatch(companyName, todayStr, parentTruckIds, groupTrucks.length, mixedCount);
        },

        getCompositeBatches: async function() {
            const user = this.getCurrentUser();
            if (!user || user.role !== 'admin') {
                throw new Error('Unauthorized: Admin access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getComposites&role=${user.role}`);
                    const data = await response.json();
                    return data.batches || [];
                } catch (e) {
                    console.error('Remote getComposites failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }
            return getDB().composite_batches;
        },

        inspectBarcode: async function(barcodeId) {
            const user = this.getCurrentUser();
            if (!user || user.role !== 'admin') {
                throw new Error('Unauthorized: Admin access required');
            }
            
            const trucks = await this.getTrucks();
            let lab1 = [];
            let composites = [];
            if (this.isRemoteMode()) {
                const [r1, r2] = await Promise.all([
                    fetch(`${this.getAppsScriptUrl()}?action=getLab1Results&role=admin`).then(r => r.json()),
                    fetch(`${this.getAppsScriptUrl()}?action=getComposites&role=admin`).then(r => r.json())
                ]);
                lab1 = r1.results || [];
                composites = r2.batches || [];
            } else {
                const db = getDB();
                lab1 = db.lab1_results;
                composites = db.composite_batches;
            }
            
            barcodeId = barcodeId.trim();
            
            // 1. Check if it's a Sample 1 barcode
            let truck = trucks.find(t => t.sample1_barcode_id === barcodeId);
            let lab1Result = lab1.find(r => r.sample1_barcode_id === barcodeId);
            
            if (!truck) {
                truck = trucks.find(t => t.truck_id === barcodeId || t.truck_reg_number.toLowerCase() === barcodeId.toLowerCase());
                if (truck) {
                    barcodeId = truck.sample1_barcode_id;
                    lab1Result = lab1.find(r => r.sample1_barcode_id === barcodeId);
                }
            }
            
            if (truck) {
                const composite = composites.find(c => {
                    let pIds = [];
                    if (Array.isArray(c.parent_truck_ids)) {
                        pIds = c.parent_truck_ids;
                    } else if (typeof c.parent_truck_ids === 'string') {
                        try { pIds = JSON.parse(c.parent_truck_ids); } catch(e) {}
                    }
                    return truck.composite_barcode_id === c.composite_barcode_id || pIds.includes(truck.truck_id);
                });
                return {
                    success: true,
                    type: 'sample1',
                    barcode_id: barcodeId,
                    truck: truck,
                    lab1: lab1Result || null,
                    composite: composite || null
                };
            }
            
            // 2. Check if it's a Composite barcode
            const parts = barcodeId.split('-');
            const baseCode = parts.length >= 3 ? parts[0] + '-' + parts[1] + '-' + parts[2] : barcodeId;
            const batch = composites.find(c => 
                c.composite_ref_id === barcodeId ||
                c.composite_ref_id === baseCode ||
                c.composite_barcode_id === barcodeId ||
                c.test_lot === barcodeId ||
                c.referee_lot === barcodeId ||
                c.vendor_lot === barcodeId ||
                (c.lots && (c.lots.test === barcodeId || c.lots.referee === barcodeId || c.lots.vendor === barcodeId))
            );
            
            if (batch) {
                let pIds = [];
                if (Array.isArray(batch.parent_truck_ids)) {
                    pIds = batch.parent_truck_ids;
                } else if (typeof batch.parent_truck_ids === 'string') {
                    try { pIds = JSON.parse(batch.parent_truck_ids); } catch(e) {}
                }
                
                const matchingTrucks = trucks.filter(t => pIds.includes(t.truck_id));
                const matchingLab1 = lab1.filter(r => matchingTrucks.map(t => t.sample1_barcode_id).includes(r.sample1_barcode_id));
                
                return {
                    success: true,
                    type: 'composite',
                    barcode_id: barcodeId,
                    batch: batch,
                    matching_trucks: matchingTrucks,
                    lab1_results: matchingLab1
                };
            }
            
            return { success: false, message: `No record found in database for barcode ID: "${barcodeId}"` };
        },

        // ================= LAB 2: GCV & ASH TESTING (STRICT COMPOSITE BLIND) =================
        getCompositeDetails: async function(compositeBarcodeId) {
            const user = this.getCurrentUser();
            const role = user ? user.role : null;
            if (!role) {
                throw new Error('Unauthorized: Please login first');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getComposite&barcodeId=${encodeURIComponent(compositeBarcodeId)}&role=${role}`);
                    return await response.json();
                } catch (e) {
                    console.error('Remote getCompositeDetails failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const batch = db.composite_batches.find(b => 
                b.composite_barcode_id === compositeBarcodeId || 
                b.lots.test === compositeBarcodeId || 
                b.lots.referee === compositeBarcodeId || 
                b.lots.vendor === compositeBarcodeId
            );

            if (!batch) {
                return { success: false, message: 'Invalid composite barcode.' };
            }

            if (role === 'lab2') {
                const isTestLot = compositeBarcodeId.endsWith('-T') || compositeBarcodeId === batch.lots.test || compositeBarcodeId === batch.composite_barcode_id;
                if (!isTestLot) {
                    return { success: false, message: 'Lab Station 2 can only process the Lab Testing Lot (-T) barcode. Referee and Vendor lots cannot be scanned for testing.' };
                }
            }

            if (role === 'lab2') {
                return {
                    success: true,
                    composite_barcode_id: batch.composite_barcode_id,
                    lot_type: compositeBarcodeId.endsWith('-R') ? 'Referee' : compositeBarcodeId.endsWith('-V') ? 'Vendor' : 'Test Lot',
                    is_tested: batch.gcv_value !== null && batch.gcv_value !== undefined,
                    gcv_value: batch.gcv_value,
                    ash_pct: batch.ash_pct,
                    tested_at: batch.tested_at
                };
            } else if (role === 'admin') {
                return {
                    success: true,
                    composite_barcode_id: batch.composite_barcode_id,
                    lot_type: compositeBarcodeId.endsWith('-R') ? 'Referee' : compositeBarcodeId.endsWith('-V') ? 'Vendor' : 'Test Lot',
                    is_tested: batch.gcv_value !== null && batch.gcv_value !== undefined,
                    gcv_value: batch.gcv_value,
                    ash_pct: batch.ash_pct,
                    tested_at: batch.tested_at,
                    meta: {
                        company_name: batch.company_name,
                        date: batch.date,
                        truck_count: batch.parent_truck_ids ? batch.parent_truck_ids.length : 0
                    }
                };
            }

            throw new Error('Unauthorized: Invalid role for Composite Lookup');
        },

        submitCompositeResult: async function(compositeBarcodeId, gcv, ash) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'lab2' && user.role !== 'admin')) {
                throw new Error('Unauthorized: Lab 2 or Admin access required');
            }

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'submitComposite',
                            compositeBarcodeId,
                            gcv: Number(gcv),
                            ash: Number(ash),
                            testedBy: user.username,
                            testedAt: timestamp
                        })
                    });
                } catch (e) {
                    console.error('Remote submitComposite failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            } else {
                const db = getDB();
                const batch = db.composite_batches.find(b => 
                    b.composite_barcode_id === compositeBarcodeId || 
                    b.lots.test === compositeBarcodeId
                );

                if (!batch) {
                    return { success: false, message: 'Composite batch barcode not found.' };
                }

                batch.gcv_value = Number(gcv);
                batch.ash_pct = Number(ash);
                batch.tested_by = user.username;
                batch.tested_at = timestamp;

                saveDB(db);
            }
            return { success: true };
        },

        getLab2History: async function() {
            const user = this.getCurrentUser();
            if (!user) throw new Error('Not logged in');

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getLab2History&username=${user.username}`);
                    return await response.json();
                } catch (e) {
                    console.error('Remote getLab2History failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const results = user.role === 'admin' 
                ? db.composite_batches.filter(b => b.gcv_value !== null)
                : db.composite_batches.filter(b => b.tested_by === user.username);

            return results.map(r => ({
                composite_barcode_id: r.composite_barcode_id,
                tested_at: r.tested_at,
                gcv_value: r.gcv_value,
                ash_pct: r.ash_pct
            }));
        },

        // ================= ADMIN: REPORT GENERATION =================
        getAdminReport: async function(companyName, date) {
            const user = this.getCurrentUser();
            if (!user || user.role !== 'admin') {
                throw new Error('Unauthorized: Admin access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getAdminReport&companyName=${encodeURIComponent(companyName)}&date=${encodeURIComponent(date)}&role=${user.role}`);
                    return await response.json();
                } catch (e) {
                    console.error('Remote getAdminReport failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const filteredTrucks = db.trucks.filter(t => 
                t.company_name === companyName && 
                t.entry_date === date
            );

            const reportRows = filteredTrucks.map(truck => {
                const lab1Res = db.lab1_results.find(r => r.sample1_barcode_id === truck.sample1_barcode_id);
                const composite = db.composite_batches.find(c => 
                    c.composite_barcode_id === truck.composite_barcode_id
                );

                return {
                    truck_id: truck.truck_id,
                    truck_reg_number: truck.truck_reg_number,
                    driver_name: truck.driver_name,
                    entry_time: truck.entry_time,
                    photo_url: truck.photo_url || '',
                    gross_weight: truck.gross_weight,
                    tare_weight: truck.tare_weight,
                    net_weight: truck.net_weight,
                    sample1_barcode: truck.sample1_barcode_id,
                    composite_barcode: composite ? composite.composite_barcode_id : null,
                    gcv_value: composite ? composite.gcv_value : null,
                    ash_pct: composite ? composite.ash_pct : null,
                    lab2_tested_at: composite ? composite.tested_at : null,
                    moisture_pct: lab1Res ? lab1Res.moisture_pct : null,
                    fineness_value: lab1Res ? lab1Res.fineness_value : null,
                    lab1_tested_at: lab1Res ? lab1Res.tested_at : null
                };
            });

            let totalNetWeight = 0;
            let sumMoisture = 0;
            let sumFineness = 0;
            let moistureCount = 0;
            let finenessCount = 0;

            reportRows.forEach(row => {
                totalNetWeight += row.net_weight;
                if (row.moisture_pct !== null) {
                    sumMoisture += row.moisture_pct;
                    moistureCount++;
                }
                if (row.fineness_value !== null) {
                    sumFineness += row.fineness_value;
                    finenessCount++;
                }
            });

            const uniqueComposites = [...new Set(reportRows.map(r => r.composite_barcode).filter(Boolean))];
            let sumGcv = 0;
            let sumAsh = 0;
            let compositeCount = 0;
            
            uniqueComposites.forEach(cId => {
                const comp = db.composite_batches.find(b => b.composite_barcode_id === cId);
                if (comp && comp.gcv_value !== null) {
                    sumGcv += comp.gcv_value;
                    sumAsh += comp.ash_pct;
                    compositeCount++;
                }
            });

            return {
                company_name: companyName,
                date: date,
                rows: reportRows,
                summary: {
                    truck_count: reportRows.length,
                    total_net_weight: totalNetWeight,
                    avg_moisture: moistureCount > 0 ? Number((sumMoisture / moistureCount).toFixed(2)) : null,
                    avg_fineness: finenessCount > 0 ? Number((sumFineness / finenessCount).toFixed(2)) : null,
                    avg_gcv: compositeCount > 0 ? Number((sumGcv / compositeCount).toFixed(0)) : null,
                    avg_ash: compositeCount > 0 ? Number((sumAsh / compositeCount).toFixed(2)) : null
                }
            };
        },

        logActivity: async function(actionName, detailsText) {
            const user = this.getCurrentUser();
            if (!user) throw new Error('Not logged in');

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
            const logEntry = {
                timestamp: timestamp,
                username: user.username,
                action: actionName,
                details: detailsText
            };

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'logActivity',
                            log: logEntry
                        })
                    });
                } catch (e) {
                    console.error('Remote logActivity failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            } else {
                const db = getDB();
                db.activity_logs = db.activity_logs || [];
                db.activity_logs.push(logEntry);
                saveDB(db);
            }
            return { success: true, log: logEntry };
        },

        getActivityLogs: async function() {
            const user = this.getCurrentUser();
            if (!user || user.role !== 'admin') {
                throw new Error('Unauthorized: Admin access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getActivityLogs`);
                    const data = await response.json();
                    return data.logs || [];
                } catch (e) {
                    console.error('Remote getActivityLogs failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            return db.activity_logs || [];
        },

        // Reset database back to empty state
        resetLocalDB: function() {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DATA));
            return getDB();
        }
    };
})();
