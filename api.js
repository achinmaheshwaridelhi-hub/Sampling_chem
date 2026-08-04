/**
 * Biomass Sampling - Data Access & Security Layer (api.js)
 * Enforces role-based access control and sanitizes responses for Lab Technicians and Gate Operators.
 * Integrates directly with the Google Sheets REST API.
 */
(function() {
    // --- MOBILE/APK FIX: every network call now times out instead of hanging forever ---
    const NETWORK_TIMEOUT_MS = 25000;
    const _nativeFetch = window.fetch.bind(window);
    function fetch(input, init) {
        init = init || {};
        if (init.signal) return _nativeFetch(input, init);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
        return _nativeFetch(input, Object.assign({}, init, { signal: ctrl.signal }))
            .catch(err => {
                if (err && err.name === 'AbortError') {
                    throw new Error('Network timeout - server did not respond. Check your internet connection and try again.');
                }
                throw err;
            })
            .finally(() => clearTimeout(timer));
    }

    const STORAGE_KEY = 'BIOMASS_DB_STATE';
    const CONFIG_KEY = 'BIOMASS_CONFIG';

    // Default User Accounts (stored as SHA-256 hashes)
    const DEFAULT_USERS = [
        { username: 'admin', password: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', role: 'admin', name: 'System Administrator' },
        { username: 'entry', password: '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf', role: 'entry', name: 'Entry Gate Operator' },
        { username: 'weighment', password: '612d15f5e3d7f9f473eedcd9325b55d321fa2ba1903b8a87826040510e8b451f', role: 'weighment', name: 'Weighment Operator' },
        { username: 'lab1', password: '68d0a03fbd404489b987e7e17ae517b2b0250bee0e719d0438d7e41129f76609', role: 'lab1', name: 'Lab Tech 1 (Moisture/Fineness)' },
        { username: 'lab2', password: '77812e70c9c6d7a0b7dbd8233f3cbe213f71ac0eecd1e6184ae5816095dab9a2', role: 'lab2', name: 'Lab Tech 2 (GCV/Ash)' },
        { username: 'moisture', password: '31bb9529338de24088742ffcdc2eadd5b35562e262c4b146a278287fc044210a', role: 'lab1m', name: 'Lab-1A Moisture Testing' },
        { username: 'fineness', password: '1811fb31c01f83266818b662a87531d72502ed54860fdd625d92b1f4fcb7d340', role: 'lab1f', name: 'Lab-1B Fineness Testing' },
        { username: 'unloading', password: 'b78cce73fc60f76e045ff6b3d4d0ac17ad360d4fd81617a2c3ec1039feae4313', role: 'unloading', name: 'After Weighment / Unloading Area' }
    ];

    // Automatic acceptance rule: moisture at or above this % rejects the consignment
    const MOISTURE_REJECT_LIMIT = 14;
    const LAB1_ROLES = ['lab1', 'lab1m', 'lab1f', 'admin'];

    function sanitizeTruckData(truck) {
        if (!truck) return null;
        const val = truck.invoice_no || truck.challan_no || truck['Challan No'] || truck['Challan No.'] || '';
        truck.invoice_no = val;
        truck.challan_no = val;
        return truck;
    }

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
            let remoteUser = null;
            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=login&username=${encodeURIComponent(username)}&hashedPassword=${encodeURIComponent(hashedPassword)}`);
                    const res = await response.json();
                    if (res.success && res.user) {
                        remoteUser = { username: res.user.username, role: res.user.role, name: res.user.name };
                    }
                } catch (e) {
                    console.warn('Remote login check failed, falling back to local credentials...', e);
                }
            }

            if (remoteUser) {
                sessionStorage.setItem('BIOMASS_SESSION', JSON.stringify(remoteUser));
                return { success: true, user: remoteUser };
            }

            // Local fallback for offline mode & pending deployment updates
            const localUser = DEFAULT_USERS.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === hashedPassword);
            if (localUser) {
                const sessionUser = { username: localUser.username, role: localUser.role, name: localUser.name };
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

            const chVal = truckData.invoice_no || truckData.challan_no || '';
            const newTruck = {
                truck_id: `TRK-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
                company_name: truckData.company_name,
                driver_name: truckData.driver_name,
                truck_reg_number: truckData.truck_reg_number,
                invoice_no: chVal,
                challan_no: chVal,
                entry_date: entryDate,
                entry_time: truckData.entry_time || new Date().toTimeString().split(' ')[0].substring(0, 5),
                photo_url: truckData.photo_url || '',
                gross_weight: Number(truckData.gross_weight) || 0,
                tare_weight: Number(truckData.tare_weight) || 0,
                net_weight: 0,
                sample1_barcode_id: generateOpaqueId('S1'),
                composite_barcode_id: '',
                created_by: user.username,
                daily_group_code: groupCode,
                acceptance_status: 'PENDING'
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
            if (!user || !['admin', 'lab2', 'weighment', 'entry', 'unloading'].includes(user.role)) {
                throw new Error('Unauthorized: Admin, Lab 2, Weighment, Entry or Unloading access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getTrucks&role=${user ? user.role : 'admin'}`);
                    const data = await response.json();
                    let list = [];
                    if (data && data.trucks && Array.isArray(data.trucks)) {
                        list = data.trucks;
                    } else if (Array.isArray(data)) {
                        list = data;
                    }
                    if (list.length > 0) {
                        list.forEach(sanitizeTruckData);
                        return list;
                    }
                } catch (e) {
                    console.warn('Remote getTrucks failed, falling back to local database:', e);
                }
            }

            const db = getDB();
            const lab1 = db.lab1_results || [];
            const mapped = db.trucks.map(function(t) {
                const res = lab1.find(function(r) { return r.sample1_barcode_id === t.sample1_barcode_id; });
                const moisture = res && res.moisture_pct !== '' && res.moisture_pct !== undefined && res.moisture_pct !== null ? Number(res.moisture_pct) : null;
                const status = moisture === null ? 'PENDING' : (moisture > 14 ? 'REJECTED' : 'ACCEPTED');
                return {
                    ...t,
                    moisture_pct: moisture,
                    acceptance_status: status
                };
            });
            mapped.forEach(sanitizeTruckData);
            return mapped;
        },

        updateWeighment: async function(truckId, grossWeight, tareWeight) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'weighment' && user.role !== 'unloading')) {
                throw new Error('Unauthorized: Admin, Weighment, or Unloading access required');
            }

            grossWeight = Number(grossWeight) || 0;
            tareWeight = Number(tareWeight) || 0;

            // --- Anti-Manipulation Lock Checks ---
            const dbCheck = getDB();
            const tCheck = dbCheck.trucks.find(t => t.truck_id === truckId);

            const existingGross = tCheck && tCheck.gross_weight ? Number(tCheck.gross_weight) : 0;
            const existingTare = tCheck && tCheck.tare_weight ? Number(tCheck.tare_weight) : 0;

            // Weighment desk records BOTH gross and final (tare) weight, but each value
            // locks permanently once submitted — a saved reading can never be re-edited.
            if (user.role === 'weighment') {
                if (existingGross > 0 && grossWeight !== existingGross) {
                    if (grossWeight > 0 && grossWeight !== existingGross) {
                        throw new Error(`Security Lock: Gross weight for truck [${truckId}] is already submitted and locked.`);
                    }
                    grossWeight = existingGross;
                }
                if (existingTare > 0 && tareWeight !== existingTare) {
                    if (tareWeight > 0 && tareWeight !== existingTare) {
                        throw new Error(`Security Lock: Final weight for truck [${truckId}] is already submitted and locked.`);
                    }
                    tareWeight = existingTare;
                }
            }

            if (user.role === 'unloading') {
                // Final weight is captured by the weighment desk; unloading is view-only for it
                if (tareWeight !== existingTare) {
                    throw new Error('Unauthorized: Final (Tare) weight must be recorded at the weighbridge / weighment login.');
                }
            }


            // Net weight calculation is always gross minus tare irrespective of acceptance status
            let netWeight = (grossWeight && tareWeight) ? (grossWeight - tareWeight) : 0;

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

            if (role === 'lab1' || role === 'lab1m' || role === 'lab1f') {
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

        submitSample1Result: async function(barcodeId, moisture, fineness, extra) {
            const user = this.getCurrentUser();
            if (!user || !LAB1_ROLES.includes(user.role)) {
                throw new Error('Unauthorized: Lab 1 (Moisture / Fineness) or Admin access required');
            }

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

            // Role scoping: the moisture desk only writes moisture, the fineness desk only writes fineness
            const canWriteMoisture = (user.role !== 'lab1f');
            const canWriteFineness = (user.role !== 'lab1m');

            const record = {
                sample1_barcode_id: barcodeId,
                moisture_pct: (canWriteMoisture && moisture !== '' && moisture !== null && moisture !== undefined) ? Number(moisture) : null,
                fineness_value: (canWriteFineness && fineness !== '' && fineness !== null && fineness !== undefined) ? Number(fineness) : null,
                tested_by: user.username,
                tested_at: timestamp,
                write_moisture: canWriteMoisture,
                write_fineness: canWriteFineness
            };

            // Fineness is now derived from an initial / final weighing pair, each backed
            // by a mandatory scale-reading photo. Carry those through to storage/sync.
            if (canWriteFineness && extra && typeof extra === 'object') {
                if (extra.fineness_initial_weight !== undefined && extra.fineness_initial_weight !== '') {
                    record.fineness_initial_weight = Number(extra.fineness_initial_weight);
                }
                if (extra.fineness_final_weight !== undefined && extra.fineness_final_weight !== '') {
                    record.fineness_final_weight = Number(extra.fineness_final_weight);
                }
                if (extra.fineness_initial_photo) record.fineness_initial_photo = extra.fineness_initial_photo;
                if (extra.fineness_final_photo) record.fineness_final_photo = extra.fineness_final_photo;
            }


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
                return { success: true, record: record };
            }

            const db = getDB();
            const truck = db.trucks.find(t => t.sample1_barcode_id === barcodeId);
            if (!truck) {
                return { success: false, message: 'Invalid barcode. Truck entry not found.' };
            }

            const existingIndex = db.lab1_results.findIndex(r => r.sample1_barcode_id === barcodeId);
            let merged;
            if (existingIndex > -1) {
                merged = Object.assign({}, db.lab1_results[existingIndex]);
            } else {
                merged = { sample1_barcode_id: barcodeId, moisture_pct: null, fineness_value: null };
            }
            if (record.write_moisture && record.moisture_pct !== null) {
                merged.moisture_pct = record.moisture_pct;
                merged.moisture_by = user.username;
                merged.moisture_at = timestamp;
            }
            if (record.write_fineness && record.fineness_value !== null) {
                merged.fineness_value = record.fineness_value;
                merged.fineness_by = user.username;
                merged.fineness_at = timestamp;
                if (record.fineness_initial_weight !== undefined) merged.fineness_initial_weight = record.fineness_initial_weight;
                if (record.fineness_final_weight !== undefined) merged.fineness_final_weight = record.fineness_final_weight;
                if (record.fineness_initial_photo) merged.fineness_initial_photo = record.fineness_initial_photo;
                if (record.fineness_final_photo) merged.fineness_final_photo = record.fineness_final_photo;
            }

            merged.tested_by = user.username;
            merged.tested_at = timestamp;

            if (existingIndex > -1) {
                db.lab1_results[existingIndex] = merged;
            } else {
                db.lab1_results.push(merged);
            }

            // ===== AUTOMATIC ACCEPTANCE / REJECTION =====
            const status = window.BiomassAPI.evaluateAcceptance(merged.moisture_pct);
            truck.acceptance_status = status;
            if (truck.gross_weight && truck.tare_weight) {
                truck.net_weight = truck.gross_weight - truck.tare_weight;
            }

            saveDB(db);
            return { success: true, record: merged, acceptance_status: status, moisture_limit: MOISTURE_REJECT_LIMIT };
        },

        // Shared acceptance rule used by UI and reports
        evaluateAcceptance: function(moisturePct) {
            if (moisturePct === null || moisturePct === undefined || moisturePct === '') return 'PENDING';
            return Number(moisturePct) >= MOISTURE_REJECT_LIMIT ? 'REJECTED' : 'ACCEPTED';
        },

        getMoistureRejectLimit: function() {
            return MOISTURE_REJECT_LIMIT;
        },

        // ================= AFTER WEIGHMENT / UNLOADING AREA =================
        getUnloadingStatus: async function(barcodeId) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'unloading' && user.role !== 'admin')) {
                throw new Error('Unauthorized: Unloading Area or Admin access required');
            }

            if (this.isRemoteMode()) {
                try {
                    const response = await fetch(`${this.getAppsScriptUrl()}?action=getUnloadingStatus&barcodeId=${encodeURIComponent(barcodeId)}&role=${user.role}`);
                    const res = await response.json();
                    return sanitizeTruckData(res);
                } catch (e) {
                    console.error('Remote getUnloadingStatus failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            const db = getDB();
            const truck = db.trucks.find(t => t.sample1_barcode_id === barcodeId || t.truck_id === barcodeId);
            if (!truck) {
                return { success: false, message: 'No truck found for this code.' };
            }
            const lab1 = db.lab1_results.find(r => r.sample1_barcode_id === truck.sample1_barcode_id);
            const moisture = lab1 && lab1.moisture_pct !== null && lab1.moisture_pct !== undefined ? Number(lab1.moisture_pct) : null;
            const status = this.evaluateAcceptance(moisture);

            const chVal = truck.invoice_no || truck.challan_no || truck['Challan No'] || truck['Challan No.'] || '';
            return {
                success: true,
                truck_id: truck.truck_id,
                truck_reg_number: truck.truck_reg_number,
                invoice_no: chVal,
                challan_no: chVal,
                company_name: truck.company_name,
                driver_name: truck.driver_name,
                daily_group_code: truck.daily_group_code || '',
                moisture_pct: moisture,
                fineness_value: lab1 && lab1.fineness_value !== null && lab1.fineness_value !== undefined ? Number(lab1.fineness_value) : null,
                gross_weight: Number(truck.gross_weight) || 0,
                tare_weight: Number(truck.tare_weight) || 0,
                net_weight: Number(truck.net_weight) || ((truck.gross_weight && truck.tare_weight) ? Number(truck.gross_weight) - Number(truck.tare_weight) : 0),
                acceptance_status: status,
                moisture_limit: MOISTURE_REJECT_LIMIT,
                unloading_allowed: status === 'ACCEPTED'
            };
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
        createCompositeBatch: async function(companyName, date, parentTruckIds, systemCount, mixedCount, groupCode) {
            const user = this.getCurrentUser();
            if (!user || (user.role !== 'admin' && user.role !== 'lab2')) {
                throw new Error('Unauthorized: Admin or Lab 2 access required');
            }

            if (!parentTruckIds || parentTruckIds.length === 0) {
                return { success: false, message: 'No trucks selected for mixing.' };
            }

            // Fall back to a local lookup of the parent trucks' daily group code if the caller didn't supply one
            let resolvedGroupCode = groupCode || '';
            if (!resolvedGroupCode) {
                const db = getDB();
                const parentTruck = db.trucks.find(t => parentTruckIds.includes(t.truck_id));
                resolvedGroupCode = parentTruck ? (parentTruck.daily_group_code || '') : '';
            }

            const refId = `CMP-${date.replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
            const newBatch = {
                composite_ref_id: refId,
                composite_barcode_id: `${refId}-T`, 
                company_name: companyName,
                date: date,
                daily_group_code: resolvedGroupCode,
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
            const searchCode = String(groupCode || '').trim().toUpperCase();
            
            const groupTrucks = trucks.filter(t => String(t.daily_group_code || '').trim().toUpperCase() === searchCode);
            
            if (groupTrucks.length === 0) {
                throw new Error(`No trucks found registered under Group Code: "${groupCode}".`);
            }

            const acceptedTrucks = groupTrucks.filter(t => t.acceptance_status !== 'REJECTED');
            const rejectedTrucks = groupTrucks.filter(t => t.acceptance_status === 'REJECTED');

            if (acceptedTrucks.length === 0) {
                throw new Error(`Cannot create composite sample: All ${groupTrucks.length} truck(s) under Group Code [${groupCode}] were REJECTED in Lab 1 moisture testing.`);
            }
            
            const companyName = acceptedTrucks[0].company_name;
            const parentTruckIds = acceptedTrucks.map(t => t.truck_id);
            const todayStr = this.formatLocalYYYYMMDD(new Date());
            
            let batches = [];
            if (this.isRemoteMode()) {
                const response = await fetch(`${this.getAppsScriptUrl()}?action=getComposites&role=${user.role}`);
                const data = await response.json();
                batches = data.batches || [];
            } else {
                batches = getDB().composite_batches;
            }
            
            const searchGroup = String(groupCode || '').trim().toUpperCase();
            const existing = batches.find(b => String(b.daily_group_code || '').trim().toUpperCase() === searchGroup);
            if (existing) {
                const testLot = (existing.lots && existing.lots.test) || existing.test_lot || existing.composite_barcode_id || `${existing.composite_ref_id}-T`;
                const refLot = (existing.lots && existing.lots.referee) || existing.referee_lot || `${existing.composite_ref_id}-R`;
                const vendLot = (existing.lots && existing.lots.vendor) || existing.vendor_lot || `${existing.composite_ref_id}-V`;

                existing.lots = {
                    test: testLot,
                    referee: refLot,
                    vendor: vendLot
                };

                return { 
                    success: true, 
                    already_exists: true, 
                    batch: existing, 
                    message: `Composite QR codes have already been generated for Group Code "${groupCode}".` 
                };
            }
            
            return await this.createCompositeBatch(companyName, todayStr, parentTruckIds, groupTrucks.length, mixedCount, groupCode);
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

        getAllDashboardData: async function() {
            let trucks = [];
            let lab1 = [];
            let composites = [];

            try {
                if (this.isRemoteMode()) {
                    try {
                        const res = await fetch(`${this.getAppsScriptUrl()}?action=getDashboardData&role=admin`).then(r => r.json());
                        if (res && res.trucks && Array.isArray(res.trucks) && res.trucks.length > 0) {
                            trucks = res.trucks;
                            lab1 = res.lab1 || [];
                            composites = res.composites || [];
                        }
                    } catch (e1) {}

                    if (!trucks || trucks.length === 0) {
                        try {
                            trucks = await this.getTrucks();
                            const [r1, r2] = await Promise.all([
                                fetch(`${this.getAppsScriptUrl()}?action=getLab1Results&role=admin`).then(r => r.json()).catch(() => ({})),
                                fetch(`${this.getAppsScriptUrl()}?action=getComposites&role=admin`).then(r => r.json()).catch(() => ({}))
                            ]);
                            lab1 = (r1 && (r1.results || r1.lab1)) || (Array.isArray(r1) ? r1 : []);
                            composites = (r2 && (r2.batches || r2.composites)) || (Array.isArray(r2) ? r2 : []);
                        } catch (e2) {}
                    }
                }
                
                if (!trucks || trucks.length === 0) {
                    const db = getDB();
                    trucks = db.trucks || [];
                    lab1 = lab1.length > 0 ? lab1 : (db.lab1_results || []);
                    composites = composites.length > 0 ? composites : (db.composite_batches || []);
                }
            } catch(err) {
                console.error('getAllDashboardData error:', err);
                const db = getDB();
                trucks = db.trucks || [];
                lab1 = db.lab1_results || [];
                composites = db.composite_batches || [];
            }

            return { trucks: trucks || [], lab1: lab1 || [], composites: composites || [] };
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
            
            // 2. Check if it's a Composite barcode (Test Lot, Referee Lot, Vendor Lot, Group Code, or Ref ID)
            const rawInput = String(barcodeId || '').replace(/MIXING GROUP:/gi, '').replace(/GROUP:/gi, '').trim().toUpperCase();
            const coreCode = rawInput.replace(/[-_][RVT]$/i, '');

            const batch = composites.find(c => {
                const cRef = String(c.composite_ref_id || '').trim().toUpperCase();
                const cBar = String(c.composite_barcode_id || '').trim().toUpperCase();
                const cTest = String(c.test_lot || (c.lots ? c.lots.test : '') || '').trim().toUpperCase();
                const cRefLot = String(c.referee_lot || (c.lots ? c.lots.referee : '') || '').trim().toUpperCase();
                const cVendLot = String(c.vendor_lot || (c.lots ? c.lots.vendor : '') || '').trim().toUpperCase();
                const cGroup = String(c.daily_group_code || '').trim().toUpperCase();

                // Direct match
                if (rawInput === cRef || rawInput === cBar || rawInput === cTest || rawInput === cRefLot || rawInput === cVendLot || rawInput === cGroup) return true;
                if (coreCode === cRef || coreCode === cBar || coreCode === cTest || coreCode === cRefLot || coreCode === cVendLot || coreCode === cGroup) return true;

                // Substring & Core code match
                if (cRef && (rawInput.includes(cRef) || cRef.includes(coreCode) || coreCode.includes(cRef))) return true;
                if (cBar && (rawInput.includes(cBar) || cBar.includes(coreCode) || coreCode.includes(cBar))) return true;
                if (cGroup && (rawInput.includes(cGroup) || coreCode.includes(cGroup))) return true;

                return false;
            });
            
            if (batch) {
                const baseRef = batch.composite_ref_id || batch.daily_group_code || 'CMP-BATCH';
                if (!batch.test_lot) batch.test_lot = (batch.lots ? batch.lots.test : '') || batch.composite_barcode_id || `${baseRef}-T`;
                if (!batch.referee_lot) batch.referee_lot = (batch.lots ? batch.lots.referee : '') || `${baseRef}-R`;
                if (!batch.vendor_lot) batch.vendor_lot = (batch.lots ? batch.lots.vendor : '') || `${baseRef}-V`;
                
                if (!batch.lots) {
                    batch.lots = {
                        test: batch.test_lot,
                        referee: batch.referee_lot,
                        vendor: batch.vendor_lot
                    };
                }

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
            }

            // Always sync into local DB cache so reports load immediately
            try {
                const db = getDB();
                const cleanTarget = String(compositeBarcodeId || '').trim().toUpperCase();
                const batch = db.composite_batches.find(b => {
                    const bRef = String(b.composite_ref_id || '').trim().toUpperCase();
                    const bBar = String(b.composite_barcode_id || '').trim().toUpperCase();
                    const bTest = String(b.test_lot || (b.lots ? b.lots.test : '') || '').trim().toUpperCase();
                    return cleanTarget === bRef || cleanTarget === bBar || cleanTarget === bTest || (bBar && cleanTarget.includes(bBar));
                });

                if (batch) {
                    batch.gcv_value = Number(gcv);
                    batch.ash_pct = Number(ash);
                    batch.tested_by = user.username;
                    batch.tested_at = timestamp;
                    saveDB(db);
                }
            } catch(dbErr) {
                console.warn('Local DB sync warning:', dbErr);
            }

            return { success: true };
        },

        updateRefereeChallenge: async function(compositeRefId, payload) {
            const user = this.getCurrentUser();
            if (!user || user.role !== 'admin') {
                throw new Error('Unauthorized: Admin access required');
            }

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

            if (this.isRemoteMode()) {
                try {
                    await fetch(this.getAppsScriptUrl(), {
                        method: 'POST',
                        mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            action: 'updateRefereeChallenge',
                            compositeRefId,
                            vendorGcv: payload.vendorGcv,
                            refereeGcv: payload.refereeGcv,
                            refereeStatus: payload.refereeStatus,
                            updatedBy: user.username
                        })
                    });
                } catch (e) {
                    console.error('Remote updateRefereeChallenge failed:', e);
                    throw new Error('Google Sheets sync failed: ' + e.message);
                }
            }

            // Sync into local DB cache
            try {
                const db = getDB();
                const cleanTarget = String(compositeRefId || '').trim().toUpperCase();
                const batch = db.composite_batches.find(b => {
                    const bRef = String(b.composite_ref_id || '').trim().toUpperCase();
                    const bBar = String(b.composite_barcode_id || '').trim().toUpperCase();
                    const bGroup = String(b.daily_group_code || '').trim().toUpperCase();
                    return cleanTarget === bRef || cleanTarget === bBar || cleanTarget === bGroup;
                });

                if (batch) {
                    if (payload.vendorGcv !== undefined) batch.vendor_gcv = payload.vendorGcv !== '' ? Number(payload.vendorGcv) : null;
                    if (payload.refereeGcv !== undefined) batch.referee_gcv = payload.refereeGcv !== '' ? Number(payload.refereeGcv) : null;
                    if (payload.refereeStatus !== undefined) batch.referee_status = payload.refereeStatus;
                    batch.referee_updated_at = timestamp;
                    saveDB(db);
                }
            } catch(e) {}

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

            const self = this;
            const reportRows = filteredTrucks.map(truck => {
                const lab1Res = db.lab1_results.find(r => r.sample1_barcode_id === truck.sample1_barcode_id);
                const composite = db.composite_batches.find(c => {
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

                const moistureVal = lab1Res && lab1Res.moisture_pct !== null && lab1Res.moisture_pct !== undefined ? Number(lab1Res.moisture_pct) : null;
                const acceptance = self.evaluateAcceptance(moistureVal);

                let rejectionReason = '';
                if (acceptance === 'REJECTED') {
                    rejectionReason = moistureVal !== null ? `Moisture ${moistureVal}% > 14.0% Max Limit` : 'REJECTED';
                } else if (acceptance === 'ACCEPTED') {
                    rejectionReason = 'Passed (Moisture <= 14.0%)';
                } else {
                    rejectionReason = 'Pending Moisture Test';
                }

                const hasGcv = composite && composite.gcv_value !== null && composite.gcv_value !== "" && composite.gcv_value !== undefined;
                const hasAsh = composite && composite.ash_pct !== null && composite.ash_pct !== "" && composite.ash_pct !== undefined;

                return {
                    truck_id: truck.truck_id,
                    truck_reg_number: truck.truck_reg_number,
                    invoice_no: chVal,
                    challan_no: chVal,
                    acceptance_status: acceptance,
                    rejection_reason: rejectionReason,
                    mixing_group_code: truck.daily_group_code || '',
                    driver_name: truck.driver_name,
                    entry_time: truck.entry_time,
                    photo_url: truck.photo_url || '',
                    gross_weight: truck.gross_weight,
                    tare_weight: truck.tare_weight,
                    net_weight: acceptance === 'REJECTED' ? 0 : truck.net_weight,
                    sample1_barcode: truck.sample1_barcode_id,
                    composite_barcode: acceptance === 'REJECTED' ? null : (composite ? (composite.composite_barcode_id || composite.composite_ref_id) : null),
                    gcv_value: acceptance === 'REJECTED' ? null : (hasGcv ? Number(composite.gcv_value) : null),
                    ash_pct: acceptance === 'REJECTED' ? null : (hasAsh ? Number(composite.ash_pct) : null),
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

            let acceptedCount = 0;
            let rejectedCount = 0;
            reportRows.forEach(row => {
                if (row.acceptance_status === 'ACCEPTED') acceptedCount++;
                if (row.acceptance_status === 'REJECTED') rejectedCount++;
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
                    accepted_count: acceptedCount,
                    rejected_count: rejectedCount,
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
