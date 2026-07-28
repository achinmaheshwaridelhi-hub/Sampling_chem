/**
 * Biomass Sampling - Main Application Controller (app.js)
 * Coordinates user interaction, webcam frames, barcode scanning, print rendering, and reporting.
 */
document.addEventListener('DOMContentLoaded', function() {
    // Current application state
    let activeCameraStream = null;
    let capturedPhotoBase64 = '';
    let activeLab1Scanner = null;
    let activeLab2Scanner = null;

    // ================= CONFIG & SECURITY KEYS =================
    // NOTE: Because this is a purely client-side web application, a technically sophisticated 
    // user can extract this symmetric key from the JavaScript source. This encryption scheme 
    // is designed to prevent casual scanning of QR codes by generic apps (like Google Lens or 
    // built-in phone scanners) to protect the double-blind integrity of the testing workflow, 
    // but is NOT a substitute for absolute server-side security.
    const CONFIG = {
        QR_SECRET_KEY: 'b3f88c3a9d024e6a8f8d2c4b8e9a1d3f5c7b9e0f1a2b3c4d5e6f7a8b9c0d1e2f'
    };

    // --- Web Crypto AES-GCM Encrypted QR Helpers ---
    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    function bytesToBase64Url(bytes) {
        let binString = '';
        for (let i = 0; i < bytes.length; i++) {
            binString += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binString);
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64UrlToBytes(b64url) {
        let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) {
            b64 += '=';
        }
        const binString = atob(b64);
        const bytes = new Uint8Array(binString.length);
        for (let i = 0; i < binString.length; i++) {
            bytes[i] = binString.charCodeAt(i);
        }
        return bytes;
    }

    async function getCryptoKey() {
        const keyBytes = hexToBytes(CONFIG.QR_SECRET_KEY);
        return await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // Encrypts a payload JSON object to an opaque string prefixed with BSW1:
    async function encryptPayload(plainId, issuedAtOverride = null) {
        try {
            const key = await getCryptoKey();
            const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit standard IV
            const payloadObj = {
                id: plainId,
                issuedAt: issuedAtOverride || Date.now()
            };
            const plainText = JSON.stringify(payloadObj);
            const encodedText = new TextEncoder().encode(plainText);
            
            const ciphertextBuffer = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                encodedText
            );
            
            const ciphertextBytes = new Uint8Array(ciphertextBuffer);
            const combined = new Uint8Array(iv.length + ciphertextBytes.length);
            combined.set(iv, 0);
            combined.set(ciphertextBytes, iv.length);
            
            return 'BSW1:' + bytesToBase64Url(combined);
        } catch (e) {
            console.error('Encryption failed:', e);
            throw new Error('Failed to encrypt QR payload');
        }
    }

    // Decrypts an opaque string. Returns { id, issuedAt }
    async function decryptPayload(token) {
        // Fallback for old CODE128 plain-text stock: if not prefixed with BSW1:, return plain ID directly
        if (!token.startsWith('BSW1:')) {
            // Check if it matches a legacy pattern (S1- or CMP-)
            if (token.startsWith('S1-') || token.startsWith('CMP-')) {
                console.log('Legacy plaintext code scanned:', token);
                return { id: token, issuedAt: Date.now(), isLegacy: true };
            }
            throw new Error('Not a valid sample QR code');
        }
        
        try {
            const base64Part = token.substring(5);
            const combined = base64UrlToBytes(base64Part);
            
            if (combined.length < 13) {
                throw new Error('Payload too short or corrupt');
            }
            
            const iv = combined.slice(0, 12);
            const ciphertextBytes = combined.slice(12);
            
            const key = await getCryptoKey();
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ciphertextBytes
            );
            
            const plainText = new TextDecoder().decode(decryptedBuffer);
            return JSON.parse(plainText);
        } catch (e) {
            console.error('Decryption failed:', e);
            throw new Error('Invalid or tampered sample QR');
        }
    }

    // Tracks active countdown intervals to prevent memory leaks
    let activeCountdowns = {};

    function startQrExpiryCountdown(issuedAt, displayElementId) {
        // Clear existing interval if any
        if (activeCountdowns[displayElementId]) {
            clearInterval(activeCountdowns[displayElementId]);
        }

        const displayEl = document.getElementById(displayElementId);
        if (!displayEl) return;

        function update() {
            const elapsed = Date.now() - issuedAt;
            const remaining = (24 * 60 * 60 * 1000) - elapsed;

            if (remaining <= 0) {
                displayEl.innerHTML = `<span style="color: var(--danger); font-weight: bold;">❌ EXPIRED</span>`;
                clearInterval(activeCountdowns[displayElementId]);
                delete activeCountdowns[displayElementId];
            } else {
                const hours = Math.floor(remaining / (1000 * 60 * 60));
                const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
                displayEl.innerHTML = `<span style="color: #059669; font-weight: bold;">⏳ Valid for ${hours}h ${minutes}m ${seconds}s</span>`;
            }
        }

        update();
        activeCountdowns[displayElementId] = setInterval(update, 1000);
    }

    function updateConnectionBanner() {
        const banner = document.getElementById('connection-mode-banner');
        if (!banner) return;
        
        if (window.BiomassAPI.isRemoteMode()) {
            banner.textContent = 'ONLINE GOOGLE SHEETS SYNC MODE';
            banner.className = 'connection-banner online';
        } else {
            banner.textContent = 'OFFLINE LOCALSTORAGE MODE';
            banner.className = 'connection-banner offline';
        }
    }

    updateConnectionBanner();

    // Dom elements cache
    const appHeader = document.getElementById('app-header');
    const displayUserName = document.getElementById('display-user-name');
    const displayUserRole = document.getElementById('display-user-role');
    const btnLogout = document.getElementById('btn-logout-action');
    
    // Screens
    const screens = {
        login: document.getElementById('screen-login'),
        admin: document.getElementById('screen-admin'),
        lab1: document.getElementById('screen-lab1'),
        lab2: document.getElementById('screen-lab2')
    };

    // Helper: download QR Code Canvas as PNG with text headers and plain ID below
    function downloadQrAsPng(canvasSelector, filename, headerText, plainId) {
        const canvasElement = document.querySelector(canvasSelector);
        if (!canvasElement) {
            alert('QR sticker element not found.');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            const headerHeight = headerText ? 40 : 0;
            const footerHeight = plainId ? 30 : 0;
            
            canvas.width = 320;
            canvas.height = 320 + headerHeight + footerHeight;
            
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            let currentY = 25;
            
            // 1. Draw Header Text
            if (headerText) {
                context.fillStyle = '#000000';
                context.font = 'bold 16pt monospace';
                context.textAlign = 'center';
                
                if (headerText.includes('MIXING GROUP:')) {
                    context.lineWidth = 3;
                    context.strokeStyle = '#000000';
                    const boxWidth = 240;
                    context.strokeRect((canvas.width - boxWidth) / 2, currentY - 18, boxWidth, 30);
                    context.fillText(headerText, canvas.width / 2, currentY + 4);
                } else {
                    context.fillText(headerText, canvas.width / 2, currentY);
                }
                currentY += headerHeight;
            }
            
            // 2. Draw QR code image from the original canvas
            context.drawImage(canvasElement, (canvas.width - 240) / 2, currentY, 240, 240);
            currentY += 240;
            
            // 3. Draw Plain ID underneath for manual fallback entry
            if (plainId) {
                context.fillStyle = '#111827';
                context.font = '10pt monospace';
                context.textAlign = 'center';
                context.fillText(plainId, canvas.width / 2, currentY + 15);
            }
            
            const png = canvas.toDataURL('image/png');
            const downloadLink = document.createElement('a');
            downloadLink.href = png;
            downloadLink.download = `${filename}.png`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
        } catch (e) {
            console.error('Failed to convert QR canvas:', e);
            alert('Sticker image download failed: ' + e.message);
        }
    }

    // Set pdf.js worker URL for PDF parsing in browser
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    }

    // Helper: decode barcode from image file or PDF document
    async function scanUploadedFile(file, qrReaderId, successCallback, errorCallback) {
        if (!file) return;
        
        try {
            if (file.type === "application/pdf" || file.name.toLowerCase().endsWith('.pdf')) {
                if (typeof pdfjsLib === 'undefined') {
                    alert('PDF reader library is loading. Please try again in a few seconds.');
                    return;
                }
                const fileReader = new FileReader();
                fileReader.onload = async function() {
                    try {
                        const typedarray = new Uint8Array(this.result);
                        const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
                        const page = await pdf.getPage(1);
                        
                        const canvas = document.createElement('canvas');
                        const viewport = page.getViewport({ scale: 2.5 }); // Sharp scale for barcode decoding
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        
                        const context = canvas.getContext('2d');
                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        canvas.toBlob(async (blob) => {
                            const tempFile = new File([blob], "scanned-page.png", { type: "image/png" });
                            const tempReader = new Html5Qrcode(qrReaderId);
                            try {
                                const decodedText = await tempReader.scanFile(tempFile, false);
                                successCallback(decodedText);
                            } catch (err) {
                                errorCallback('Could not decode barcode from PDF page. Make sure the barcode is clear and not cropped.');
                            }
                        }, "image/png");
                    } catch (err) {
                        errorCallback('Failed to read PDF document: ' + err.message);
                    }
                };
                fileReader.readAsArrayBuffer(file);
            } else {
                // Standard image file parsing (simplified for QR codes with legacy fallback)
                const fileReader = new FileReader();
                fileReader.onload = function(event) {
                    const img = new Image();
                    img.onload = async function() {
                        // Pass 1: Try Native BarcodeDetector first (highly robust, supports QR and legacy CODE128)
                        if (typeof window.BarcodeDetector !== 'undefined') {
                            try {
                                const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
                                const detectedCodes = await detector.detect(img);
                                if (detectedCodes && detectedCodes.length > 0) {
                                    console.log('Successfully scanned using Native BarcodeDetector:', detectedCodes[0].rawValue);
                                    successCallback(detectedCodes[0].rawValue);
                                    return;
                                }
                            } catch (detectorErr) {
                                console.warn('Native BarcodeDetector check failed:', detectorErr);
                            }
                        }

                        // Pass 2: Resize image to an optimized size canvas (max 800px) and scan
                        const canvas = document.createElement('canvas');
                        const maxDim = 800;
                        let w = img.width;
                        let h = img.height;
                        if (w > maxDim || h > maxDim) {
                            if (w > h) {
                                h = Math.round((h * maxDim) / w);
                                w = maxDim;
                            } else {
                                w = Math.round((w * maxDim) / h);
                                h = maxDim;
                            }
                        }
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);
                        
                        canvas.toBlob(async (blob) => {
                            const resizedFile = new File([blob], "resized-scan.png", { type: "image/png" });
                            try {
                                const rawReader = new Html5Qrcode(qrReaderId);
                                const rawText = await rawReader.scanFile(resizedFile, false);
                                console.log('Successfully scanned using Html5Qrcode on resized canvas');
                                successCallback(rawText);
                            } catch (rawErr) {
                                // Pass 3: Fall back to original raw file scan
                                try {
                                    const rawReader = new Html5Qrcode(qrReaderId);
                                    const rawText = await rawReader.scanFile(file, false);
                                    console.log('Successfully scanned using Html5Qrcode raw scan');
                                    successCallback(rawText);
                                } catch (rawErr2) {
                                    errorCallback('Could not read QR code or barcode from this photo. Please make sure the photo is well-lit and the code is not skewed or blurry.');
                                }
                            }
                        }, "image/png");
                    };
                    img.src = event.target.result;
                };
                fileReader.onloaderror = function(err) {
                    errorCallback('Failed to read uploaded file: ' + err.message);
                };
                fileReader.readAsDataURL(file);
            }
        } catch (err) {
            errorCallback('Failed to decode uploaded file: ' + err.message);
        }
    }

    // ================= SESSION ROUTING & CONTROL =================
    function routeSession() {
        // Stop any running camera streams or scanners first
        stopAllCameras();

        const user = window.BiomassAPI.getCurrentUser();
        
        // Hide all screens
        Object.values(screens).forEach(s => s.classList.remove('active'));

        if (!user) {
            appHeader.style.display = 'none';
            screens.login.classList.add('active');
            document.getElementById('login-username').value = '';
            document.getElementById('login-password').value = '';
            return;
        }

        // Setup Header
        appHeader.style.display = 'flex';
        displayUserName.textContent = user.name;
        displayUserRole.textContent = user.role;

        // Redirect based on role
        if (user.role === 'admin' || user.role === 'entry' || user.role === 'weighment') {
            screens.admin.classList.add('active');
            initAdminDashboard(user.role);
        } else if (user.role === 'lab1') {
            screens.lab1.classList.add('active');
            initLab1Screen();
        } else if (user.role === 'lab2') {
            screens.lab2.classList.add('active');
            initLab2Screen();
        }

        applyRoleBasedPrivileges();
    }

    function applyRoleBasedPrivileges() {
        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;
        
        const btnResetDb = document.getElementById('btn-settings-reset-db');
        if (btnResetDb) {
            if (role === 'admin') {
                btnResetDb.style.display = 'inline-block';
                btnResetDb.removeAttribute('disabled');
            } else {
                btnResetDb.style.display = 'none';
                btnResetDb.setAttribute('disabled', 'true');
            }
        }
        
        const tabBtnActivity = document.getElementById('tab-btn-activity');
        if (tabBtnActivity) {
            tabBtnActivity.style.display = (role === 'admin') ? 'flex' : 'none';
        }
    }

    // Bind Logout
    btnLogout.addEventListener('click', function() {
        window.BiomassAPI.logout();
        routeSession();
    });

    // Helper to calculate SHA-256 of text
    async function hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Handle Login Submit
    const loginForm = document.getElementById('login-form');
    const loginAlert = document.getElementById('login-alert');

    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        loginAlert.style.display = 'none';
        
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        try {
            const hashedPassword = await hashPassword(password);
            const res = await window.BiomassAPI.login(username, hashedPassword);
            if (res.success) {
                routeSession();
            } else {
                loginAlert.textContent = res.message;
                loginAlert.style.display = 'flex';
            }
        } catch (err) {
            loginAlert.textContent = 'Connection error: ' + err.message;
            loginAlert.style.display = 'flex';
        }
    });

    // Helper: Stop camera streams and QR readers
    async function stopAllCameras() {
        if (activeCameraStream) {
            activeCameraStream.getTracks().forEach(track => track.stop());
            activeCameraStream = null;
        }
        if (activeLab1Scanner) {
            try { await activeLab1Scanner.stop(); } catch(e){}
            activeLab1Scanner = null;
        }
        if (activeLab2Scanner) {
            try { await activeLab2Scanner.stop(); } catch(e){}
            activeLab2Scanner = null;
        }
        document.getElementById('lab1-scanner-container').style.display = 'none';
        document.getElementById('lab2-scanner-container').style.display = 'none';
        document.getElementById('camera-stream-panel').style.display = 'none';
    }

    // ================= ADMIN & ENTRY DASHBOARD CONTROLLERS =================
    let companiesSet = new Set();

    function initAdminDashboard(role) {
        const tabs = document.querySelectorAll('#screen-admin .tab-btn');
        const tabContents = document.querySelectorAll('#screen-admin .tab-content');

        // Apply menu item visibility based on role (Entry Operator sees ONLY registration, Weighment sees ONLY weighment)
        tabs.forEach(tab => {
            const dataTab = tab.getAttribute('data-tab');
            if (role === 'entry') {
                if (dataTab !== 'admin-register') {
                    tab.style.display = 'none';
                } else {
                    tab.style.display = 'flex';
                }
            } else if (role === 'weighment') {
                if (dataTab !== 'admin-weighment') {
                    tab.style.display = 'none';
                } else {
                    tab.style.display = 'flex';
                }
            } else {
                tab.style.display = 'flex'; // admin sees everything
            }
        });

        // Force other tab contents to hide completely
        tabContents.forEach(content => {
            const id = content.getAttribute('id');
            if (role === 'entry') {
                if (id !== 'tab-admin-register') {
                    content.style.setProperty('display', 'none', 'important');
                } else {
                    content.style.display = '';
                }
            } else if (role === 'weighment') {
                if (id !== 'tab-admin-weighment') {
                    content.style.setProperty('display', 'none', 'important');
                } else {
                    content.style.display = '';
                }
            } else {
                content.style.display = ''; // reset to default active rules for Admin
            }
        });

        // If Entry role, force the registration tab active and hide others
        if (role === 'entry') {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            const regTab = document.querySelector('#screen-admin .tab-btn[data-tab="admin-register"]');
            if (regTab) {
                regTab.classList.add('active');
                document.getElementById('tab-admin-register').classList.add('active');
            }
        }

        // If Weighment role, force the weighment tab active and hide others
        if (role === 'weighment') {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            const weighTab = document.querySelector('#screen-admin .tab-btn[data-tab="admin-weighment"]');
            if (weighTab) {
                weighTab.classList.add('active');
                document.getElementById('tab-admin-weighment').classList.add('active');
            }
        }

        tabs.forEach(tab => {
            tab.removeEventListener('click', handleTabClick);
            tab.addEventListener('click', handleTabClick);
        });

        function handleTabClick(e) {
            // SECURITY: Block tab clicking for Entry Operator and Weighment Operator roles
            if (role === 'entry' || role === 'weighment') {
                e.preventDefault();
                return;
            }

            const clickedTab = e.currentTarget;
            if (clickedTab.classList.contains('active')) {
                return;
            }

            const targetContentId = `tab-${clickedTab.getAttribute('data-tab')}`;

            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            clickedTab.classList.add('active');
            document.getElementById(targetContentId).classList.add('active');

            // Hook for refreshing specific tabs on click
            if (targetContentId === 'tab-admin-weighment') {
                renderWeighmentLog();
            } else if (targetContentId === 'tab-admin-composite') {
                loadCompositeSelectors();
            } else if (targetContentId === 'tab-admin-reports') {
                loadReportSelectors();
            } else if (targetContentId === 'tab-admin-inspector') {
                initAdminInspectorTab();
            } else if (targetContentId === 'tab-admin-activity') {
                renderActivityLogTab();
            }
        }

        // Initialize Registration view options
        loadSupplierDataLists();
        setupRegistrationCamera();
    }

    async function loadSupplierDataLists() {
        try {
            const compSelect = document.getElementById('comp-select-company');
            const reportSelect = document.getElementById('report-select-company');
            
            const prevCompVal = compSelect ? compSelect.value : '';
            const prevReportVal = reportSelect ? reportSelect.value : '';

            const companies = await window.BiomassAPI.getCompanies();
            companies.forEach(c => companiesSet.add(c));
            
            const sortedCompanies = Array.from(companiesSet).sort();

            const datalist = document.getElementById('companies-list');
            datalist.innerHTML = '';
            
            if (compSelect) compSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';
            if (reportSelect) reportSelect.innerHTML = '<option value="">-- Choose Supplier --</option>';

            sortedCompanies.forEach(company => {
                // Datalist options
                const opt = document.createElement('option');
                opt.value = company;
                datalist.appendChild(opt);

                // Dropdown options
                if (compSelect) {
                    const opt1 = document.createElement('option');
                    opt1.value = company;
                    opt1.textContent = company;
                    compSelect.appendChild(opt1);
                }

                if (reportSelect) {
                    const opt2 = document.createElement('option');
                    opt2.value = company;
                    opt2.textContent = company;
                    reportSelect.appendChild(opt2);
                }
            });

            // Preserve selections
            if (compSelect && prevCompVal) {
                compSelect.value = prevCompVal;
            }
            if (reportSelect && prevReportVal) {
                reportSelect.value = prevReportVal;
            }
        } catch (e) {
            console.error('Failed to load companies list:', e);
        }
    }

    // --- Admin: Camera Capture integration ---
    function setupRegistrationCamera() {
        const btnTrigger = document.getElementById('btn-trigger-camera');
        const btnSnap = document.getElementById('btn-snap-photo');
        const btnCancel = document.getElementById('btn-cancel-photo');
        const btnDelete = document.getElementById('btn-delete-photo');
        const videoFeed = document.getElementById('webcam-feed');
        
        const cameraPanel = document.getElementById('camera-stream-panel');
        const previewPanel = document.getElementById('captured-preview-panel');
        const photoStatus = document.getElementById('photo-status');
        const capturedImg = document.getElementById('captured-image-img');

        btnTrigger.onclick = async function() {
            try {
                previewPanel.style.display = 'none';
                cameraPanel.style.display = 'block';
                
                activeCameraStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment', width: 640, height: 480 }
                });
                videoFeed.srcObject = activeCameraStream;
            } catch (err) {
                console.error('Webcam access error:', err);
                alert('Could not start webcam stream. Please make sure camera permissions are enabled.');
                cameraPanel.style.display = 'none';
            }
        };

        btnSnap.onclick = function() {
            if (!activeCameraStream) return;

            const canvas = document.createElement('canvas');
            canvas.width = videoFeed.videoWidth || 640;
            canvas.height = videoFeed.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoFeed, 0, 0, canvas.width, canvas.height);
            
            // Compress image to JPEG
            capturedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.7);
            
            capturedImg.src = capturedPhotoBase64;
            previewPanel.style.display = 'block';
            
            photoStatus.textContent = 'Photo Attached';
            photoStatus.classList.remove('badge-pending');
            photoStatus.classList.add('badge-complete');

            stopCameraStream();
        };

        btnCancel.onclick = stopCameraStream;

        btnDelete.onclick = function() {
            capturedPhotoBase64 = '';
            capturedImg.src = '';
            previewPanel.style.display = 'none';
            photoStatus.textContent = 'No Photo Attached';
            photoStatus.classList.remove('badge-complete');
            photoStatus.classList.add('badge-pending');
        };

        function stopCameraStream() {
            if (activeCameraStream) {
                activeCameraStream.getTracks().forEach(track => track.stop());
                activeCameraStream = null;
            }
            cameraPanel.style.display = 'none';
        }
    }

    // --- Admin: Handle Truck Registration Submit ---
    const truckRegForm = document.getElementById('truck-reg-form');
    truckRegForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const data = {
            company_name: document.getElementById('reg-company').value.trim(),
            driver_name: document.getElementById('reg-driver').value.trim(),
            truck_reg_number: document.getElementById('reg-vehicle').value.trim(),
            gross_weight: 0,
            tare_weight: 0,
            photo_url: capturedPhotoBase64
        };

        try {
            const truck = await window.BiomassAPI.registerTruck(data);
            
            if (data.company_name) {
                companiesSet.add(data.company_name);
            }

            // Set Group Code Display
            document.getElementById('s1-group-code-display').textContent = `MIXING GROUP: ${truck.daily_group_code || 'N/A'}`;

            // Generate Secure Encrypted Payload
            const encrypted = await encryptPayload(truck.sample1_barcode_id);

            // Render QR Code onto the Canvas
            QRCode.toCanvas(document.getElementById('qr-canvas-s1'), encrypted, {
                errorCorrectionLevel: 'H',
                width: 180,
                margin: 2
            }, function(err) {
                if (err) console.error('QR code generation failed:', err);
            });

            startQrExpiryCountdown(Date.now(), 's1-qr-expiry');

            document.getElementById('admin-barcodes-result').style.display = 'block';
            
            // Attach print & download triggers (Only S1 QR)
            setupBarcodePrintTriggers(truck.sample1_barcode_id, truck.daily_group_code);

            // Clean registration form
            truckRegForm.reset();
            document.getElementById('btn-delete-photo').click(); 
            loadSupplierDataLists(); 
            
            alert('Truck registered successfully! Encrypted QR code generated.');
        } catch (err) {
            alert('Registration failed: ' + err.message);
        }
    });

    // Helper: set print & download layout trigger buttons (Only S1)
    function setupBarcodePrintTriggers(s1Id, dailyGroupCode) {
        const printContainer = document.getElementById('print-section');

        document.getElementById('btn-print-s1').onclick = async function() {
            const encrypted = await encryptPayload(s1Id);
            printContainer.innerHTML = `
                <div class="print-label-view" style="text-align: center;">
                    <div style="font-size: 24pt; font-weight: bold; border: 4px solid black; padding: 10px; margin-bottom: 12px; display: inline-block;">
                        MIXING GROUP: ${dailyGroupCode || 'N/A'}
                    </div>
                    <div>
                        <canvas id="print-qr-target"></canvas>
                    </div>
                    <div style="font-size: 11pt; font-family: monospace; margin-top: 8px;">
                        ${s1Id}
                    </div>
                </div>
            `;
            QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                errorCorrectionLevel: 'H',
                width: 150,
                margin: 2
            }, function(err) {
                if (err) console.error(err);
                setTimeout(() => { window.print(); }, 200);
            });
        };
 
        // Download as PNG button
        document.getElementById('btn-download-s1').onclick = function() {
            downloadQrAsPng(
                '#qr-canvas-s1', 
                `Sample_1_${s1Id}`, 
                `MIXING GROUP: ${dailyGroupCode || 'N/A'}`,
                s1Id
            );
        };
    }

    // --- Admin: Weighment Log ---
    const searchWeighInput = document.getElementById('weigh-search');
    searchWeighInput.addEventListener('input', renderWeighmentLog);

    async function renderWeighmentLog() {
        const tbody = document.getElementById('table-weighment-body');
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">Loading trucks...</td></tr>';
        
        try {
            const trucks = await window.BiomassAPI.getTrucks();
            const filter = searchWeighInput.value.toLowerCase().trim();
            tbody.innerHTML = '';

            const filtered = trucks.filter(t => 
                t.truck_id.toLowerCase().includes(filter) ||
                t.company_name.toLowerCase().includes(filter) ||
                t.truck_reg_number.toLowerCase().includes(filter)
            );

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">No matching truck entries found today.</td></tr>';
                return;
            }

            filtered.slice().reverse().forEach(truck => {
                const tr = document.createElement('tr');
                
                const hasPhoto = !!truck.photo_url;
                const photoHtml = hasPhoto 
                    ? `<img class="truck-photo-thumb" src="${truck.photo_url}" onclick="window.viewPhoto('${truck.photo_url}', '${truck.truck_id} / ${truck.truck_reg_number}')">`
                    : '<span style="font-size: 0.75rem; color: #f87171;">No Photo</span>';

                const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
                const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);

                tr.innerHTML = `
                    <td><strong>${truck.truck_id}</strong></td>
                    <td>${dateStr} ${timeStr}</td>
                    <td>${truck.company_name}</td>
                    <td><span style="font-family: monospace;">${truck.truck_reg_number}</span></td>
                    <td>${truck.gross_weight || '-'}</td>
                    <td>${truck.tare_weight || '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${truck.net_weight || '-'}</td>
                    <td style="text-align: center;">${photoHtml}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="window.triggerWeighmentEdit('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">
                            Update weight
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger);">Failed to load: ${e.message}</td></tr>`;
        }
    }

    window.viewPhoto = function(url, caption) {
        const lightbox = document.getElementById('lightbox');
        const img = document.getElementById('lightbox-img');
        const text = document.getElementById('lightbox-caption');

        img.src = url;
        text.textContent = caption;
        lightbox.style.display = 'flex';
    };

    window.triggerWeighmentEdit = function(id, gross, tare) {
        const card = document.getElementById('weighment-edit-card');
        document.getElementById('weigh-edit-truck-id').value = id;
        document.getElementById('weigh-edit-title').textContent = `Update Weighment logs for [${id}]`;
        document.getElementById('weigh-edit-gross').value = gross || '';
        document.getElementById('weigh-edit-tare').value = tare || '';
        
        card.style.display = 'block';
        calculateEditNet();
        card.scrollIntoView({ behavior: 'smooth' });
    };

    const editGross = document.getElementById('weigh-edit-gross');
    const editTare = document.getElementById('weigh-edit-tare');
    const editNet = document.getElementById('weigh-edit-net');

    editGross.oninput = calculateEditNet;
    editTare.oninput = calculateEditNet;

    function calculateEditNet() {
        const g = Number(editGross.value) || 0;
        const t = Number(editTare.value) || 0;
        const net = g > t ? (g - t) : 0;
        editNet.textContent = `${net.toLocaleString()} kg`;
    }

    document.getElementById('btn-cancel-weigh').onclick = () => {
        document.getElementById('weighment-edit-card').style.display = 'none';
    };

    document.getElementById('weigh-edit-form').onsubmit = async function(e) {
        e.preventDefault();
        const id = document.getElementById('weigh-edit-truck-id').value;
        const g = editGross.value;
        const t = editTare.value;

        try {
            const res = await window.BiomassAPI.updateWeighment(id, g, t);
            if (res.success) {
                alert('Weighment updated successfully.');
                document.getElementById('weighment-edit-card').style.display = 'none';
                renderWeighmentLog();
            } else {
                alert('Update failed: ' + res.message);
            }
        } catch (err) {
            alert('API communication error: ' + err.message);
        }
    };

    // --- Admin: Composite Batching ---
    async function loadCompositeSelectors() {
        await loadSupplierDataLists();
        document.getElementById('composite-selection-table-wrapper').style.display = 'none';
        document.getElementById('composite-output-card').style.display = 'none';
        document.getElementById('comp-select-date').value = new Date().toISOString().split('T')[0];
    }

    const btnLoadParent = document.getElementById('btn-load-parent-samples');
    btnLoadParent.onclick = async function() {
        const company = document.getElementById('comp-select-company').value;
        const date = document.getElementById('comp-select-date').value;

        if (!company || !date) {
            alert('Please select both supplier and date.');
            return;
        }

        const tbody = document.getElementById('composite-parent-table-body');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading matching samples...</td></tr>';
        document.getElementById('composite-selection-table-wrapper').style.display = 'block';

        try {
            const trucks = await window.BiomassAPI.getTrucks();

            // Filter trucks for company + date (safely parsing/substringing Google date formats)
            const matching = trucks.filter(t => {
                const normalizedEntryDate = window.BiomassAPI.formatLocalYYYYMMDD(t.entry_date);
                return t.company_name === company && normalizedEntryDate === date;
            });

            tbody.innerHTML = '';

            if (matching.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No trucks found arriving from this supplier on the selected date.</td></tr>';
                return;
            }

            const allBatched = matching.every(t => !!t.composite_barcode_id);
            if (allBatched) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; background: #fffbeb; border: 1px solid #fef3c7; color: #b45309; padding: 1.25rem; font-weight: bold; border-radius: 6px;">⚠️ Note: All trucks arriving from this supplier today have already been mixed into a composite lot.<br><span style="font-weight: normal; font-size: 0.85rem; display: block; margin-top: 0.25rem;">You can lookup details inside Compiled Reports or the new Barcode Inspector tab.</span></td></tr>';
                return;
            }

            matching.forEach(truck => {
                const isBatched = !!truck.composite_barcode_id;

                const tr = document.createElement('tr');
                tr.className = 'truck-select-row' + (isBatched ? ' is-batched' : '');
                
                const checkboxHtml = isBatched
                    ? '<span>-</span>'
                    : `<input type="checkbox" name="parent-sample-select" value="${truck.truck_id}">`;

                const statusBadge = isBatched 
                    ? '<span class="badge badge-complete">Already Batched</span>'
                    : '<span class="badge badge-pending">Available for Mixing</span>';

                tr.innerHTML = `
                    <td>${checkboxHtml}</td>
                    <td><strong>${truck.truck_id}</strong></td>
                    <td><span style="font-family: monospace;">${truck.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${truck.sample1_barcode_id}</span></td>
                    <td><span class="badge badge-referee" style="font-weight: bold;">${truck.daily_group_code || 'N/A'}</span></td>
                    <td>${statusBadge}</td>
                `;

                if (!isBatched) {
                    tr.onclick = function(e) {
                        if (e.target.tagName !== 'INPUT') {
                            const cb = tr.querySelector('input[type="checkbox"]');
                            cb.checked = !cb.checked;
                            tr.classList.toggle('selected', cb.checked);
                        } else {
                            tr.classList.toggle('selected', e.target.checked);
                        }
                    };
                }

                tbody.appendChild(tr);
            });

            const checkAll = document.getElementById('check-all-samples');
            checkAll.checked = false;
            checkAll.onclick = function() {
                const checkboxes = document.querySelectorAll('input[name="parent-sample-select"]');
                checkboxes.forEach(cb => {
                    cb.checked = checkAll.checked;
                    cb.closest('tr').classList.toggle('selected', checkAll.checked);
                });
            };

        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger);">Failed to search: ${e.message}</td></tr>`;
        }
    };

    // Generate Composite Batch
    const btnCreateComp = document.getElementById('btn-create-composite');
    btnCreateComp.onclick = async function() {
        const company = document.getElementById('comp-select-company').value;
        const date = document.getElementById('comp-select-date').value;
        
        const checkboxes = document.querySelectorAll('input[name="parent-sample-select"]:checked');
        const selectedIds = Array.from(checkboxes).map(cb => cb.value);

        if (selectedIds.length === 0) {
            alert('Please select at least one truck sample to mix.');
            return;
        }

        try {
            const res = await window.BiomassAPI.createCompositeBatch(company, date, selectedIds, selectedIds.length, selectedIds.length);
            if (res.success) {
                const batch = res.batch;
                alert(`Composite batch created successfully for ${selectedIds.length} trucks!`);
                
                // Show output card
                const outputCard = document.getElementById('composite-output-card');
                outputCard.style.display = 'block';

                // Render QR codes
                const testEnc = await encryptPayload(batch.lots.test);
                const refEnc = await encryptPayload(batch.lots.referee);
                const vendEnc = await encryptPayload(batch.lots.vendor);
                
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-test'), testEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-ref'), refEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-vend'), vendEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });

                const now = Date.now();
                startQrExpiryCountdown(now, 'comp-test-qr-expiry');
                startQrExpiryCountdown(now, 'comp-ref-qr-expiry');
                startQrExpiryCountdown(now, 'comp-vend-qr-expiry');

                // Setup Sticker Printing and Downloading Triggers
                setupCompositePrintTriggers(batch);

                // Reload search inputs
                btnLoadParent.click();
            } else {
                alert('Mixing failed: ' + res.message);
            }
        } catch (err) {
            alert('API communication error: ' + err.message);
        }
    };

    function setupCompositePrintTriggers(batch) {
        const printContainer = document.getElementById('print-section');
        
        const setupPrint = async (lotId, type) => {
            const encrypted = await encryptPayload(lotId);
            printContainer.innerHTML = `
                <div class="print-label-view" style="text-align: center;">
                    <h3 style="font-size: 18pt; font-weight: bold; margin: 0 0 10px 0;">${type}</h3>
                    <div>
                        <canvas id="print-qr-target"></canvas>
                    </div>
                    <div style="font-size: 11pt; font-family: monospace; margin-top: 8px;">
                        ${lotId}
                    </div>
                </div>
            `;
            QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                errorCorrectionLevel: 'H',
                width: 150,
                margin: 2
            }, function(err) {
                if (err) console.error(err);
                setTimeout(() => { window.print(); }, 200);
            });
        };
 
        document.getElementById('btn-print-comp-test').onclick = () => setupPrint(batch.lots.test, "TEST LOT (-T)");
        document.getElementById('btn-print-comp-ref').onclick = () => setupPrint(batch.lots.referee, "REFEREE LOT (-R)");
        document.getElementById('btn-print-comp-vend').onclick = () => setupPrint(batch.lots.vendor, "VENDOR LOT (-V)");
 
        // Wire download buttons
        document.getElementById('btn-download-comp-test').onclick = () => downloadQrAsPng(
            '#qr-canvas-comp-test', 
            `Composite_TEST_${batch.lots.test}`,
            "TEST LOT (-T)",
            batch.lots.test
        );
        document.getElementById('btn-download-comp-ref').onclick = () => downloadQrAsPng(
            '#qr-canvas-comp-ref', 
            `Composite_REFEREE_${batch.lots.referee}`,
            "REFEREE LOT (-R)",
            batch.lots.referee
        );
        document.getElementById('btn-download-comp-vend').onclick = () => downloadQrAsPng(
            '#qr-canvas-comp-vend', 
            `Composite_VENDOR_${batch.lots.vendor}`,
            "VENDOR LOT (-V)",
            batch.lots.vendor
        );
    }

    // --- Admin: Compiled Reports Generation ---
    async function loadReportSelectors() {
        await loadSupplierDataLists();
        document.getElementById('report-output-panel').style.display = 'none';
        document.getElementById('report-select-date').value = new Date().toISOString().split('T')[0];
    }

    const btnCompileReport = document.getElementById('btn-compile-report');
    btnCompileReport.onclick = async function() {
        const company = document.getElementById('report-select-company').value;
        const date = document.getElementById('report-select-date').value;

        if (!company || !date) {
            alert('Please select both supplier and date.');
            return;
        }

        try {
            const report = await window.BiomassAPI.getAdminReport(company, date);
            
            if (report.rows.length === 0) {
                alert('No truck entry logs recorded for this supplier on the selected date.');
                document.getElementById('report-output-panel').style.display = 'none';
                return;
            }

            // Populate Panel
            document.getElementById('report-company-title').textContent = report.company_name;
            document.getElementById('report-date-title').textContent = report.date;

            document.getElementById('summary-truck-count').textContent = report.summary.truck_count;
            document.getElementById('summary-net-weight').textContent = `${report.summary.total_net_weight.toLocaleString()} kg`;
            document.getElementById('summary-avg-moisture').textContent = report.summary.avg_moisture !== null ? `${report.summary.avg_moisture}%` : 'Pending';
            document.getElementById('summary-avg-fineness').textContent = report.summary.avg_fineness !== null ? `${report.summary.avg_fineness}%` : 'Pending';
            
            const gcvVal = report.summary.avg_gcv !== null ? `${report.summary.avg_gcv} kcal` : 'Pending';
            const ashVal = report.summary.avg_ash !== null ? `${report.summary.avg_ash}%` : 'Pending';
            document.getElementById('summary-avg-composite').textContent = `${gcvVal} / ${ashVal}`;

            // Populate rows
            const tbody = document.getElementById('report-rows-body');
            tbody.innerHTML = '';

            report.rows.forEach(row => {
                const tr = document.createElement('tr');
                
                const hasPhoto = !!row.photo_url;
                const photoHtml = hasPhoto
                    ? `<img class="truck-photo-thumb" src="${row.photo_url}" onclick="window.viewPhoto('${row.photo_url}', '${row.truck_id}')">`
                    : '<span style="font-size: 0.75rem; color: #9ca3af;">No Photo</span>';

                tr.innerHTML = `
                    <td><strong>${row.truck_id}</strong></td>
                    <td><span style="font-family: monospace;">${row.truck_reg_number}</span></td>
                    <td>${row.driver_name}</td>
                    <td>${row.net_weight ? row.net_weight.toLocaleString() + ' kg' : 'Pending'}</td>
                    <td><span style="font-family: monospace; font-size: 0.8rem;">${row.sample1_barcode}</span></td>
                    <td style="font-weight: 500;">${row.moisture_pct !== null ? row.moisture_pct + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="font-weight: 500;">${row.fineness_value !== null ? row.fineness_value + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td><span style="font-family: monospace; font-size: 0.8rem;">${row.composite_barcode || 'Unmixed'}</span></td>
                    <td style="font-weight: 500;">${row.gcv_value !== null ? row.gcv_value : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="font-weight: 500;">${row.ash_pct !== null ? row.ash_pct + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="text-align: center;">${photoHtml}</td>
                `;
                tbody.appendChild(tr);
            });

            document.getElementById('report-output-panel').style.display = 'block';
            document.getElementById('report-output-panel').scrollIntoView({ behavior: 'smooth' });

            setupReportPrintTrigger(report);

        } catch (err) {
            alert('Failed to compile report: ' + err.message);
        }
    };

    function setupReportPrintTrigger(report) {
        const btnPrint = document.getElementById('btn-print-report-action');
        const btnPdf = document.getElementById('btn-export-pdf-action');
        const printContainer = document.getElementById('print-section');

        function generatePrintHtml() {
            let rowHtml = '';
            report.rows.forEach(r => {
                rowHtml += `
                    <tr>
                        <td><strong>${r.truck_id}</strong></td>
                        <td>${r.truck_reg_number}</td>
                        <td>${r.driver_name}</td>
                        <td>${r.net_weight ? r.net_weight.toLocaleString() : 'Pending'}</td>
                        <td>${r.sample1_barcode}</td>
                        <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : 'Pending'}</td>
                        <td>${r.fineness_value !== null ? r.fineness_value + '%' : 'Pending'}</td>
                        <td>${r.composite_barcode || 'Unmixed'}</td>
                        <td>${r.gcv_value !== null ? r.gcv_value : 'Pending'}</td>
                        <td>${r.ash_pct !== null ? r.ash_pct + '%' : 'Pending'}</td>
                    </tr>
                `;
            });

            printContainer.innerHTML = `
                <div class="print-report-view">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 1rem; margin-bottom: 1.5rem; border-bottom: 2px solid black; padding-bottom: 0.75rem;">
                        <img src="ntpc-logo.png" alt="NTPC Logo" style="height: 50px;">
                        <div style="text-align: left;">
                            <h1 style="font-size: 20pt; font-weight: bold; margin: 0; color: #000; font-family: var(--font-sans);">NTPC LIMITED</h1>
                            <h3 style="font-size: 11pt; font-weight: bold; letter-spacing: 0.05em; margin: 0; color: #444; font-family: var(--font-sans);">CHEMISTRY DEPARTMENT</h3>
                        </div>
                    </div>
                    
                    <h2 style="font-size: 16pt; font-weight: bold; text-align: center; margin-bottom: 1rem;">OFFICIAL BIOMASS LAB QUALITY REPORT</h2>
                    
                    <div class="report-meta-info">
                        <div><strong>Supplier Company:</strong> ${report.company_name}</div>
                        <div><strong>Intake Date:</strong> ${report.date}</div>
                        <div><strong>Generated At:</strong> ${new Date().toLocaleString()}</div>
                    </div>
                    
                    <table>
                        <thead>
                            <tr>
                                <th>Truck ID</th>
                                <th>Vehicle Reg</th>
                                <th>Driver Name</th>
                                <th>Net (kg)</th>
                                <th>S1 Code</th>
                                <th>Moisture %</th>
                                <th>Fineness %</th>
                                <th>Composite ID</th>
                                <th>GCV (kcal)</th>
                                <th>Ash %</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowHtml}
                        </tbody>
                    </table>

                    <div class="print-summary-grid">
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Total Trucks</div>
                            <div class="print-summary-val">${report.summary.truck_count}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Total Net Weight</div>
                            <div class="print-summary-val">${report.summary.total_net_weight.toLocaleString()} kg</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg Moisture</div>
                            <div class="print-summary-val">${report.summary.avg_moisture !== null ? report.summary.avg_moisture + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg Fineness</div>
                            <div class="print-summary-val">${report.summary.avg_fineness !== null ? report.summary.avg_fineness + '%' : 'Pending'}</div>
                        </div>
                        <div class="print-summary-card">
                            <div class="print-summary-lbl">Avg GCV / Ash</div>
                            <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">
                                ${report.summary.avg_gcv !== null ? report.summary.avg_gcv + ' kcal' : 'Pending'} / 
                                ${report.summary.avg_ash !== null ? report.summary.avg_ash + '%' : 'Pending'}
                            </div>
                        </div>
                    </div>

                    <div class="print-signature-section">
                        <div class="print-signature-box">
                            <strong>Prepared By</strong><br>
                            <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                            <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                        </div>
                        <div class="print-signature-box">
                            <strong>Verified By</strong><br>
                            <span style="font-size: 9pt; color: #444;">Name: ___________________</span><br>
                            <span style="font-size: 9pt; color: #444;">Designation: _____________</span>
                        </div>
                    </div>
                </div>
            `;
        }

        btnPrint.onclick = function() {
            generatePrintHtml();
            setTimeout(() => { window.print(); }, 200);
        };

        if (btnPdf) {
            btnPdf.onclick = function() {
                generatePrintHtml();
                const oldTitle = document.title;
                const cleanCompany = report.company_name.replace(/[^a-zA-Z0-9]/g, '_');
                document.title = `${cleanCompany}_Quality_Report_${report.date}`;
                setTimeout(() => {
                    window.print();
                    document.title = oldTitle;
                }, 200);
            };
        }
    }

    // --- Admin: Settings ---
    const settingsApiUrl = document.getElementById('settings-api-url');
    const btnSettingsSave = document.getElementById('btn-settings-save');
    const btnSettingsReset = document.getElementById('btn-settings-reset-db');

    btnSettingsSave.onclick = function() {
        const url = settingsApiUrl.value.trim();
        window.BiomassAPI.setAppsScriptUrl(url);
        updateConnectionBanner();
        alert('Configuration saved! Mode: ' + (url ? 'Google Sheets Sync API' : 'Client LocalStorage Mode'));
    };

    btnSettingsReset.onclick = function() {
        if (confirm('Are you sure you want to reset the database? This will clear your custom records.')) {
            window.BiomassAPI.resetLocalDB();
            loadSupplierDataLists();
            alert('Database reset successfully.');
        }
    };

    async function renderActivityLogTab() {
        const activityBody = document.getElementById('activity-log-body');
        const exceptionsBody = document.getElementById('exceptions-log-body');
        
        activityBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading activity log...</td></tr>';
        exceptionsBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading exception logs...</td></tr>';
        
        try {
            const logs = await window.BiomassAPI.getActivityLogs();
            activityBody.innerHTML = '';
            exceptionsBody.innerHTML = '';
            
            const generalLogs = [];
            const exceptionLogs = [];
            
            logs.forEach(log => {
                const isException = 
                    log.action.toLowerCase().includes('exception') || 
                    log.action.toLowerCase().includes('reissue') || 
                    log.action.toLowerCase().includes('lockout') || 
                    log.details.toLowerCase().includes('fail') || 
                    log.details.toLowerCase().includes('expired') || 
                    log.details.toLowerCase().includes('tampered');
                
                if (isException) {
                    exceptionLogs.push(log);
                }
                generalLogs.push(log); // Keep everything in general log for complete auditing
            });
            
            // Render general logs
            if (generalLogs.length === 0) {
                activityBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No activity logs recorded.</td></tr>';
            } else {
                generalLogs.slice().reverse().forEach(log => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="font-family: monospace; font-size: 0.85rem;">${log.timestamp}</td>
                        <td><span class="user-role" style="background: rgba(59, 130, 246, 0.15); color: var(--secondary); padding: 0.1rem 0.4rem; border-radius: 4px;">${log.username}</span></td>
                        <td><strong>${log.action}</strong></td>
                        <td style="font-size: 0.85rem;">${log.details}</td>
                    `;
                    activityBody.appendChild(tr);
                });
            }
            
            // Render exceptions
            if (exceptionLogs.length === 0) {
                exceptionsBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No critical exceptions or security violations flagged.</td></tr>';
            } else {
                exceptionLogs.slice().reverse().forEach(log => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="font-family: monospace; font-size: 0.85rem; color: #ef4444;">${log.timestamp}</td>
                        <td><span class="user-role" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; padding: 0.1rem 0.4rem; border-radius: 4px;">${log.username}</span></td>
                        <td><strong style="color: #ef4444;">${log.action}</strong></td>
                        <td style="font-size: 0.85rem; font-weight: 500;">${log.details}</td>
                    `;
                    exceptionsBody.appendChild(tr);
                });
            }
        } catch (e) {
            activityBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load logs: ${e.message}</td></tr>`;
            exceptionsBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load exceptions: ${e.message}</td></tr>`;
        }
    }

    settingsApiUrl.value = window.BiomassAPI.getAppsScriptUrl();

    // Wire Test Connection button
    const btnTestConn = document.getElementById('btn-settings-test-connection');
    const connStatus = document.getElementById('settings-connection-status');

    btnTestConn.onclick = async function() {
        const url = settingsApiUrl.value.trim();
        connStatus.style.display = 'block';
        
        if (!url) {
            connStatus.style.background = '#f3f4f6';
            connStatus.style.color = '#374151';
            connStatus.style.borderColor = '#d1d5db';
            connStatus.innerHTML = `<strong>LocalStorage Mode Active</strong><br>No Google Sheets Web App URL is set. The system is operating in local mock storage sandbox.`;
            return;
        }

        connStatus.style.background = '#eff6ff';
        connStatus.style.color = '#1e40af';
        connStatus.style.borderColor = '#bfdbfe';
        connStatus.innerHTML = `⏳ <strong>Testing connection...</strong><br>Connecting to Google Sheets Web App deployment at:<br><code style="font-size: 0.8rem; word-break: break-all;">${url}</code>`;

        try {
            // Attempt a GET request to the diagnostic ping endpoint
            const testUrl = `${url}${url.includes('?') ? '&' : '?'}action=ping`;
            const response = await fetch(testUrl);
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    connStatus.style.background = '#ecfdf5';
                    connStatus.style.color = '#065f46';
                    connStatus.style.borderColor = '#a7f3d0';
                    connStatus.innerHTML = `<strong>✅ Connection Successful!</strong><br>Google Sheets REST API is responding correctly.<br>Received: <em>"${data.message}"</em><br>Data synchronization is active.`;
                } else {
                    connStatus.style.background = '#fffbeb';
                    connStatus.style.color = '#854d0e';
                    connStatus.style.borderColor = '#fef08a';
                    connStatus.innerHTML = `<strong>⚠️ Partial Connection Response</strong><br>Connected, but the server returned a warning: ${data.message || 'Unknown response structure'}.`;
                }
            } else {
                connStatus.style.background = '#fef2f2';
                connStatus.style.color = '#991b1b';
                connStatus.style.borderColor = '#fca5a5';
                connStatus.innerHTML = `<strong>❌ Connection Failed!</strong><br>Server returned HTTP Status: ${response.status} (${response.statusText}).<br>Verify your URL and script deployment.`;
            }
        } catch (err) {
            console.error('Connection test error:', err);
            connStatus.style.background = '#fef2f2';
            connStatus.style.color = '#991b1b';
            connStatus.style.borderColor = '#fca5a5';
            connStatus.innerHTML = `
                <strong>❌ Connection Failed (Failed to fetch)</strong><br>
                The browser could not establish a connection to the Google Apps Script Web App.<br><br>
                <strong>Common causes and how to fix them:</strong>
                <ol style="margin-top: 0.5rem; padding-left: 1.25rem; text-align: left; line-height: 1.6;">
                    <li><strong>Incorrect Deployment Access Level (Most Common)</strong>:<br>
                        By default, new Google deployments are restricted to "Only myself".<br>
                        <strong>Fix:</strong> In your Google Apps Script window, click <strong>Deploy</strong> &gt; <strong>Manage deployments</strong>. Edit the active deployment (pencil icon), change <strong>"Who has access"</strong> from "Only myself" to <strong>"Anyone"</strong>, and click <strong>Deploy</strong>.
                    </li>
                    <li style="margin-top: 0.5rem;"><strong>New Deployment URL Required</strong>:<br>
                        Each time you change the script code and deploy, Google generates a <strong>new URL ID</strong>.<br>
                        <strong>Fix:</strong> Copy the new Web App URL shown at the end of the deployment process and paste it here.
                    </li>
                    <li style="margin-top: 0.5rem;"><strong>CORS Policy Block</strong>:<br>
                        Make sure you have authorized the script to access your spreadsheet and that the URL ends with <code>/exec</code>.
                    </li>
                </ol>
            `;
        }
    };


    async function processScannedCode(inputCode) {
        const trimmed = inputCode.trim();
        if (!trimmed) {
            throw new Error('Code is empty');
        }

        let payload;
        try {
            // Try decrypting. If it's a legacy CODE128 plain ID, decryptPayload returns it directly.
            payload = await decryptPayload(trimmed);
        } catch (decErr) {
            // Log security exception for invalid/tampered token
            const currentUser = window.BiomassAPI.getCurrentUser();
            const username = currentUser ? currentUser.username : 'anonymous';
            await window.BiomassAPI.logActivity('Security Exception', `Invalid or tampered token scan attempt by ${username}: "${trimmed.substring(0, 30)}..."`);
            throw decErr;
        }
        
        // Expiry date (24-hour validity) for all roles except admin
        const currentUser = window.BiomassAPI.getCurrentUser();
        const role = currentUser ? currentUser.role : null;
        
        if (role !== 'admin' && !payload.isLegacy) {
            const ageMs = Date.now() - payload.issuedAt;
            const limitMs = 24 * 60 * 60 * 1000; // 24 hours
            if (ageMs > limitMs) {
                await window.BiomassAPI.logActivity('Scan Exception', `Expired QR scanned by ${currentUser ? currentUser.username : 'unknown'}: ${payload.id}`);
                throw new Error('This QR code has expired (older than 24 hours). Please contact Admin to reissue a new sample label.');
            }
        }
        
        return payload.id;
    }

    // ================= LAB 1 STATION 1 CONTROLLER (BLIND Moisture & Fineness) =================
    function initLab1Screen() {
        document.getElementById('lab1-entry-card').style.display = 'none';
        document.getElementById('lab1-manual-input').value = '';
        renderLab1History();
        setupLab1CameraScanner();
        setupLab1FileUploadScanner();
    }

    function setupLab1CameraScanner() {
        const trigger = document.getElementById('lab1-scan-trigger');
        const container = document.getElementById('lab1-scanner-container');
        const btnStop = document.getElementById('btn-lab1-stop-scan');

        trigger.onclick = function() {
            container.style.display = 'block';
            trigger.style.display = 'none';

            activeLab1Scanner = new Html5Qrcode("lab1-qr-reader");
            activeLab1Scanner.start(
                { facingMode: "environment" },
                {
                    fps: 15,
                    qrbox: { width: 260, height: 110 },
                    formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128 ]
                },
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('lab1-manual-input').value = plainId;
                        lookupLab1Barcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    stopScanning();
                },
                function(err) {}
            ).catch(err => {
                alert('Error opening camera scanner: ' + err.message + '\n\nPlease scan using a USB scanner or type manually.');
                stopScanning();
            });
        };

        btnStop.onclick = stopScanning;

        function stopScanning() {
            if (activeLab1Scanner) {
                activeLab1Scanner.stop().then(() => {
                    activeLab1Scanner = null;
                }).catch(e => {});
            }
            container.style.display = 'none';
            trigger.style.display = 'flex';
        }
    }

    // Pilot file/PDF-upload barcode scanning for Lab 1
    function setupLab1FileUploadScanner() {
        const fileInput = document.getElementById('lab1-file-input');
        fileInput.addEventListener('change', function(e) {
            if (e.target.files.length === 0) return;
            const file = e.target.files[0];
            
            scanUploadedFile(
                file,
                "lab1-qr-reader",
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('lab1-manual-input').value = plainId;
                        lookupLab1Barcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    fileInput.value = '';
                },
                function(errorMessage) {
                    alert(errorMessage);
                    fileInput.value = '';
                }
            );
        });
    }

    const btnLab1Lookup = document.getElementById('btn-lab1-lookup');
    btnLab1Lookup.onclick = async () => {
        const barcode = document.getElementById('lab1-manual-input').value.trim();
        try {
            const plainId = await processScannedCode(barcode);
            lookupLab1Barcode(plainId);
        } catch (e) {
            alert(e.message);
        }
    };

    async function lookupLab1Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a barcode ID.');
            return;
        }

        const entryCard = document.getElementById('lab1-entry-card');
        const alertBox = document.getElementById('lab1-alert');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';

        try {
            const data = await window.BiomassAPI.getSample1Details(barcode);
            if (data.success) {
                entryCard.style.display = 'block';
                document.getElementById('lab1-blind-code').textContent = '✅ ACTIVE SECURE SAMPLE';
                document.getElementById('lab1-barcode-id').value = data.sample1_barcode_id;

                if (data.meta || data.company_name || data.truck_reg_number) {
                    console.error('Collusion leak warning: Identity metadata detected in lab session!');
                }

                const moistureInput = document.getElementById('lab1-moisture');
                const finenessInput = document.getElementById('lab1-fineness');
                const form = document.getElementById('lab1-entry-form');
                const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

                if (data.is_tested) {
                    moistureInput.value = data.moisture_pct;
                    finenessInput.value = data.fineness_value;
                    moistureInput.disabled = true;
                    finenessInput.disabled = true;
                    if (submitBtn) submitBtn.disabled = true;
                    
                    alertBox.textContent = `Error: This report has been locked and submitted at ${data.tested_at}. No further edits are allowed.`;
                    alertBox.className = 'alert alert-danger';
                    alertBox.style.display = 'flex';
                } else {
                    moistureInput.value = '';
                    finenessInput.value = '';
                    moistureInput.disabled = false;
                    finenessInput.disabled = false;
                    if (submitBtn) submitBtn.disabled = false;
                }

                document.getElementById('lab1-moisture').focus();
            } else {
                alert('Invalid lookup: ' + data.message);
            }
        } catch (err) {
            alert('Lookup failed: ' + err.message);
        }
    }

    const lab1Form = document.getElementById('lab1-entry-form');
    lab1Form.onsubmit = async function(e) {
        e.preventDefault();
        
        const barcode = document.getElementById('lab1-barcode-id').value;
        const moisture = document.getElementById('lab1-moisture').value;
        const fineness = document.getElementById('lab1-fineness').value;

        try {
            const res = await window.BiomassAPI.submitSample1Result(barcode, moisture, fineness);
            if (res.success) {
                alert('Sample analysis locked and submitted successfully!');
                document.getElementById('lab1-entry-card').style.display = 'none';
                document.getElementById('lab1-manual-input').value = '';
                renderLab1History();
            } else {
                alert('Submission failed: ' + res.message);
            }
        } catch (err) {
            alert('Submission error: ' + err.message);
        }
    };

    async function renderLab1History() {
        const tbody = document.getElementById('lab1-history-body');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading history...</td></tr>';

        try {
            const history = await window.BiomassAPI.getLab1History();
            tbody.innerHTML = '';
            
            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No tests submitted by your account today.</td></tr>';
                return;
            }

            history.slice().reverse().forEach((row, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Sample #${history.length - idx}</strong></td>
                    <td>${row.moisture_pct}%</td>
                    <td>${row.fineness_value}%</td>
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load history: ${e.message}</td></tr>`;
        }
    }


    // ================= LAB 2 STATION 2 CONTROLLER (BLIND Composite GCV & Ash) =================
    function initLab2Screen() {
        document.getElementById('lab2-entry-card').style.display = 'none';
        document.getElementById('lab2-manual-input').value = '';
        document.getElementById('lab2-group-code-input').value = '';
        document.getElementById('lab2-composite-output').style.display = 'none';
        renderLab2History();
        setupLab2CameraScanner();
        setupLab2FileUploadScanner();
        setupLab2GroupCodeGenerator();
    }

    function setupLab2CameraScanner() {
        const trigger = document.getElementById('lab2-scan-trigger');
        const container = document.getElementById('lab2-scanner-container');
        const btnStop = document.getElementById('btn-lab2-stop-scan');

        trigger.onclick = function() {
            container.style.display = 'block';
            trigger.style.display = 'none';

            activeLab2Scanner = new Html5Qrcode("lab2-qr-reader");
            activeLab2Scanner.start(
                { facingMode: "environment" },
                {
                    fps: 15,
                    qrbox: { width: 260, height: 110 },
                    formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128 ]
                },
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('lab2-manual-input').value = plainId;
                        lookupLab2Barcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    stopScanning();
                },
                function(err) {}
            ).catch(err => {
                alert('Error opening camera scanner: ' + err.message + '\n\nPlease scan using a USB scanner or type manually.');
                stopScanning();
            });
        };

        btnStop.onclick = stopScanning;

        function stopScanning() {
            if (activeLab2Scanner) {
                activeLab2Scanner.stop().then(() => {
                    activeLab2Scanner = null;
                }).catch(e => {});
            }
            container.style.display = 'none';
            trigger.style.display = 'flex';
        }
    }

    // Pilot file/PDF-upload barcode scanning for Lab 2
    function setupLab2FileUploadScanner() {
        const fileInput = document.getElementById('lab2-file-input');
        fileInput.addEventListener('change', function(e) {
            if (e.target.files.length === 0) return;
            const file = e.target.files[0];
            
            scanUploadedFile(
                file,
                "lab2-qr-reader",
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('lab2-manual-input').value = plainId;
                        lookupLab2Barcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    fileInput.value = '';
                },
                function(errorMessage) {
                    alert(errorMessage);
                    fileInput.value = '';
                }
            );
        });
    }

    function setupLab2GroupCodeGenerator() {
        const btnGen = document.getElementById('btn-lab2-generate-composite');
        const groupInput = document.getElementById('lab2-group-code-input');
        const outputDiv = document.getElementById('lab2-composite-output');
        
        btnGen.onclick = async function() {
            const groupCode = groupInput.value.trim().toUpperCase();
            if (!groupCode) {
                alert('Please enter a 3-letter Mixing Group Code.');
                return;
            }
            
            btnGen.disabled = true;
            btnGen.textContent = 'Generating...';
            
            try {
                // Verify entries in system for this Group Code today
                const trucks = await window.BiomassAPI.getTrucks();
                const todayStr = window.BiomassAPI.formatLocalYYYYMMDD(new Date());
                const groupTrucks = trucks.filter(t => {
                    const normalizedDate = window.BiomassAPI.formatLocalYYYYMMDD(t.entry_date);
                    return t.daily_group_code === groupCode && normalizedDate === todayStr;
                });
                
                if (groupTrucks.length === 0) {
                    alert(`No trucks registered today under Group Code: "${groupCode}".`);
                    btnGen.disabled = false;
                    btnGen.textContent = 'Generate';
                    return;
                }
                
                // Confirm counts with technician
                const physicalCountStr = prompt(`System matches ${groupTrucks.length} arrived sample(s) today for Group Code "${groupCode}".\n\nHow many physical samples did you mix in the laboratory?`);
                if (physicalCountStr === null) {
                    btnGen.disabled = false;
                    btnGen.textContent = 'Generate';
                    return;
                }
                
                const physicalCount = parseInt(physicalCountStr, 10);
                if (isNaN(physicalCount) || physicalCount <= 0) {
                    alert('Invalid count entered. Composite generation cancelled.');
                    btnGen.disabled = false;
                    btnGen.textContent = 'Generate';
                    return;
                }
                
                if (physicalCount !== groupTrucks.length) {
                    const confirmMismatch = confirm(`WARNING: Mismatch detected!\n- System count showing: ${groupTrucks.length} sample(s)\n- Laboratory mixed count: ${physicalCount} sample(s)\n\nAre you sure you want to compile these composite barcodes anyway?`);
                    if (!confirmMismatch) {
                        btnGen.disabled = false;
                        btnGen.textContent = 'Generate';
                        return;
                    }
                }
                
                const res = await window.BiomassAPI.generateCompositeFromGroup(groupCode, physicalCount);
                if (res.success) {
                    const batch = res.batch;
                    outputDiv.style.display = 'block';
                    
                    // Render QR codes
                    const testEnc = await encryptPayload(batch.lots.test);
                    const refEnc = await encryptPayload(batch.lots.referee);
                    const vendEnc = await encryptPayload(batch.lots.vendor);

                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-test'), testEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-ref'), refEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-vend'), vendEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });

                    const now = Date.now();
                    startQrExpiryCountdown(now, 'lab2-test-qr-expiry');
                    startQrExpiryCountdown(now, 'lab2-ref-qr-expiry');
                    startQrExpiryCountdown(now, 'lab2-vend-qr-expiry');
                    
                    alert(`Composite QR codes compiled successfully for Group [${groupCode}]!`);
                    
                    // Setup print trigger for the 3 stickers
                    const printContainer = document.getElementById('print-section');
                    const setupPrint = async (lotId, type) => {
                        const encrypted = await encryptPayload(lotId);
                        printContainer.innerHTML = `
                            <div class="print-label-view" style="text-align: center;">
                                <h3 style="font-size: 18pt; font-weight: bold; margin: 0 0 10px 0;">${type}</h3>
                                <div>
                                    <canvas id="print-qr-target"></canvas>
                                </div>
                                <div style="font-size: 11pt; font-family: monospace; margin-top: 8px;">
                                    ${lotId}
                                </div>
                            </div>
                        `;
                        QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                            errorCorrectionLevel: 'H',
                            width: 150,
                            margin: 2
                        }, function(err) {
                            if (err) console.error(err);
                            setTimeout(() => { window.print(); }, 200);
                        });
                    };
                    
                    document.getElementById('btn-print-lab2-test').onclick = () => setupPrint(batch.lots.test, "TEST LOT (-T)");
                    document.getElementById('btn-print-lab2-ref').onclick = () => setupPrint(batch.lots.referee, "REFEREE LOT (-R)");
                    document.getElementById('btn-print-lab2-vend').onclick = () => setupPrint(batch.lots.vendor, "VENDOR LOT (-V)");
                    
                    // Setup download triggers
                    document.getElementById('btn-download-lab2-test').onclick = () => downloadQrAsPng(
                        '#qr-canvas-lab2-test', 
                        `Composite_Test_${batch.lots.test}`,
                        "TEST LOT (-T)",
                        batch.lots.test
                    );
                    document.getElementById('btn-download-lab2-ref').onclick = () => downloadQrAsPng(
                        '#qr-canvas-lab2-ref', 
                        `Composite_Referee_${batch.lots.referee}`,
                        "REFEREE LOT (-R)",
                        batch.lots.referee
                    );
                    document.getElementById('btn-download-lab2-vend').onclick = () => downloadQrAsPng(
                        '#qr-canvas-lab2-vend', 
                        `Composite_Vendor_${batch.lots.vendor}`,
                        "VENDOR LOT (-V)",
                        batch.lots.vendor
                    );
                } else {
                    alert('Failed to generate composite: ' + res.message);
                }
            } catch (err) {
                alert('Generation failed: ' + err.message);
            } finally {
                btnGen.disabled = false;
                btnGen.textContent = 'Generate';
            }
        };
    }

    const btnLab2Lookup = document.getElementById('btn-lab2-lookup');
    btnLab2Lookup.onclick = async () => {
        const barcode = document.getElementById('lab2-manual-input').value.trim();
        try {
            const plainId = await processScannedCode(barcode);
            lookupLab2Barcode(plainId);
        } catch (e) {
            alert(e.message);
        }
    };

    async function lookupLab2Barcode(barcode) {
        if (!barcode) {
            alert('Please scan or type a composite barcode ID.');
            return;
        }

        const entryCard = document.getElementById('lab2-entry-card');
        const alertBox = document.getElementById('lab2-alert');
        entryCard.style.display = 'none';
        alertBox.style.display = 'none';

        try {
            const data = await window.BiomassAPI.getCompositeDetails(barcode);
            if (data.success) {
                entryCard.style.display = 'block';
                document.getElementById('lab2-blind-code').textContent = `✅ ACTIVE SECURE COMPOSITE (${data.lot_type})`;
                document.getElementById('lab2-barcode-id').value = data.composite_barcode_id;

                if (data.meta || data.company_name || data.parent_truck_ids) {
                    console.error('Collusion leak warning: Identity metadata detected in composite lab session!');
                }

                const gcvInput = document.getElementById('lab2-gcv');
                const ashInput = document.getElementById('lab2-ash');
                const form = document.getElementById('lab2-entry-form');
                const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

                if (data.is_tested) {
                    gcvInput.value = data.gcv_value;
                    ashInput.value = data.ash_pct;
                    gcvInput.disabled = true;
                    ashInput.disabled = true;
                    if (submitBtn) submitBtn.disabled = true;
                    
                    alertBox.textContent = `Error: This report has been locked and submitted at ${data.tested_at}. No further edits are allowed.`;
                    alertBox.className = 'alert alert-danger';
                    alertBox.style.display = 'flex';
                } else {
                    gcvInput.value = '';
                    ashInput.value = '';
                    gcvInput.disabled = false;
                    ashInput.disabled = false;
                    if (submitBtn) submitBtn.disabled = false;
                }

                document.getElementById('lab2-gcv').focus();
            } else {
                alert('Invalid lookup: ' + data.message);
            }
        } catch (err) {
            alert('Lookup failed: ' + err.message);
        }
    }

    const lab2Form = document.getElementById('lab2-entry-form');
    lab2Form.onsubmit = async function(e) {
        e.preventDefault();
        
        const barcode = document.getElementById('lab2-barcode-id').value;
        const gcv = document.getElementById('lab2-gcv').value;
        const ash = document.getElementById('lab2-ash').value;

        try {
            const res = await window.BiomassAPI.submitCompositeResult(barcode, gcv, ash);
            if (res.success) {
                alert('Composite batch analysis locked and submitted successfully!');
                document.getElementById('lab2-entry-card').style.display = 'none';
                document.getElementById('lab2-manual-input').value = '';
                renderLab2History();
            } else {
                alert('Submission failed: ' + res.message);
            }
        } catch (err) {
            alert('Submission error: ' + err.message);
        }
    };

    async function renderLab2History() {
        const tbody = document.getElementById('lab2-history-body');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading history...</td></tr>';

        try {
            const history = await window.BiomassAPI.getLab2History();
            tbody.innerHTML = '';
            
            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No composite tests submitted by your account today.</td></tr>';
                return;
            }

            history.slice().reverse().forEach((row, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Composite #${history.length - idx}</strong></td>
                    <td>${row.gcv_value} kcal/kg</td>
                    <td>${row.ash_pct}%</td>
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load history: ${e.message}</td></tr>`;
        }
    }

    // ================= BARCODE INSPECTOR TAB (ADMIN) =================
    let activeInspectorScanner = null;
    function initAdminInspectorTab() {
        document.getElementById('inspector-result-card').style.display = 'none';
        document.getElementById('inspector-manual-input').value = '';
        setupInspectorCameraScanner();
        setupInspectorFileUploadScanner();
    }

    function setupInspectorCameraScanner() {
        const trigger = document.getElementById('inspector-scan-trigger');
        const container = document.getElementById('inspector-scanner-container');
        const btnStop = document.getElementById('btn-inspector-stop-scan');

        trigger.onclick = function() {
            container.style.display = 'block';
            trigger.style.display = 'none';

            activeInspectorScanner = new Html5Qrcode("inspector-qr-reader");
            activeInspectorScanner.start(
                { facingMode: "environment" },
                {
                    fps: 15,
                    qrbox: { width: 260, height: 110 },
                    formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128 ]
                },
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('inspector-manual-input').value = plainId;
                        lookupInspectorBarcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    stopScanning();
                },
                function(err) {}
            ).catch(err => {
                alert('Error opening camera scanner: ' + err.message + '\n\nPlease type the barcode manually.');
                stopScanning();
            });
        };

        btnStop.onclick = stopScanning;

        function stopScanning() {
            if (activeInspectorScanner) {
                activeInspectorScanner.stop().then(() => {
                    activeInspectorScanner = null;
                }).catch(e => {});
            }
            container.style.display = 'none';
            trigger.style.display = 'flex';
        }
    }

    function setupInspectorFileUploadScanner() {
        const fileInput = document.getElementById('inspector-file-input');
        fileInput.addEventListener('change', function(e) {
            if (e.target.files.length === 0) return;
            const file = e.target.files[0];
            
            scanUploadedFile(
                file,
                "inspector-qr-reader",
                async function(decodedText) {
                    try {
                        const plainId = await processScannedCode(decodedText);
                        document.getElementById('inspector-manual-input').value = plainId;
                        lookupInspectorBarcode(plainId);
                    } catch (e) {
                        alert(e.message);
                    }
                    fileInput.value = '';
                },
                function(errorMessage) {
                    alert(errorMessage);
                    fileInput.value = '';
                }
            );
        });
    }

    document.getElementById('btn-inspector-lookup').onclick = async () => {
        const barcode = document.getElementById('inspector-manual-input').value.trim();
        try {
            const plainId = await processScannedCode(barcode);
            lookupInspectorBarcode(plainId);
        } catch (e) {
            alert(e.message);
        }
    };

    async function lookupInspectorBarcode(barcode) {
        if (!barcode) {
            alert('Please scan, upload, or type a barcode.');
            return;
        }

        const resultCard = document.getElementById('inspector-result-card');
        const resultContent = document.getElementById('inspector-result-content');
        resultCard.style.display = 'none';

        try {
            const res = await window.BiomassAPI.inspectBarcode(barcode);
            if (res.success) {
                resultCard.style.display = 'block';
                
                if (res.type === 'sample1') {
                    const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(res.truck.entry_date);
                    const timeStr = window.BiomassAPI.formatLocalTime(res.truck.entry_time);
                    
                    let lab1Html = '';
                    if (res.lab1) {
                        lab1Html = `
                            <div class="lab-meta-display" style="background: #ecfdf5; border-color: #a7f3d0; margin-top: 1rem; color: #065f46;">
                                <strong>Lab Station 1 Results:</strong><br>
                                • Moisture: ${res.lab1.moisture_pct}%<br>
                                • Fineness: ${res.lab1.fineness_value}%<br>
                                • Tested By: ${res.lab1.tested_by}<br>
                                • Tested At: ${res.lab1.tested_at}
                            </div>
                        `;
                    } else {
                        lab1Html = `
                            <div class="lab-meta-display" style="background: #fef3c7; border-color: #fde68a; margin-top: 1rem; color: #92400e;">
                                ⚠️ No Lab 1 results submitted yet.
                            </div>
                        `;
                    }
                    
                    let compositeHtml = '';
                    if (res.composite) {
                        compositeHtml = `
                            <div class="lab-meta-display" style="background: #eff6ff; border-color: #bfdbfe; margin-top: 1rem; color: #1e40af;">
                                <strong>Composite Mixing Lot Details:</strong><br>
                                • Composite Ref: ${res.composite.composite_ref_id}<br>
                                • Company: ${res.composite.company_name}<br>
                                • Compilation Date: ${res.composite.date}<br>
                                • GCV Value: ${res.composite.gcv_value || 'Pending Lab 2'}<br>
                                • Ash Content: ${res.composite.ash_pct ? res.composite.ash_pct + '%' : 'Pending Lab 2'}
                            </div>
                        `;
                    } else {
                        compositeHtml = `
                            <div class="lab-meta-display" style="background: #f3f4f6; border-color: #e5e7eb; margin-top: 1rem; color: #374151;">
                                • Composite Lot Status: Not yet compiled/mixed.
                            </div>
                        `;
                    }

                    resultContent.innerHTML = `
                        <div class="lab-meta-display" style="margin-bottom: 1rem; text-align: center; background: #f3f4f6; color: black; font-weight: bold; font-size: 1rem;">
                            INTAKE SAMPLE 1 BARCODE: ${res.barcode_id}
                        </div>
                        <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-muted);">
                            <strong>Truck ID:</strong> ${res.truck.truck_id}<br>
                            <strong>Supplier Name:</strong> ${res.truck.company_name}<br>
                            <strong>Daily Mixing Group Code:</strong> <span class="badge badge-complete" style="font-size: 0.85rem;">${res.truck.daily_group_code || 'N/A'}</span><br>
                            <strong>Driver Name:</strong> ${res.truck.driver_name}<br>
                            <strong>Vehicle Registration:</strong> ${res.truck.truck_reg_number}<br>
                            <strong>Date / Time of Intake:</strong> ${dateStr} ${timeStr}<br>
                            <strong>Gross Weight:</strong> ${res.truck.gross_weight || '-'} kg<br>
                            <strong>Tare Weight:</strong> ${res.truck.tare_weight || '-'} kg<br>
                            <strong>Net Weight:</strong> <strong style="color: var(--primary);">${res.truck.net_weight || '-'} kg</strong><br>
                            <strong>Registered By:</strong> ${res.truck.created_by || 'system'}
                        </div>
                        ${lab1Html}
                        ${compositeHtml}
                    `;
                } else if (res.type === 'composite') {
                    let trucksHtml = res.matching_trucks.map(t => `• ${t.truck_id} (${t.truck_reg_number})`).join('<br>');
                    
                    let lab2ResultsHtml = '';
                    if (res.batch.gcv_value !== null && res.batch.gcv_value !== "") {
                        lab2ResultsHtml = `
                            <div class="lab-meta-display" style="background: #ecfdf5; border-color: #a7f3d0; margin-top: 1rem; color: #065f46;">
                                <strong>Lab Station 2 Results:</strong><br>
                                • GCV Value: ${res.batch.gcv_value} kcal/kg<br>
                                • Ash Content: ${res.batch.ash_pct}%<br>
                                • Tested By: ${res.batch.tested_by}<br>
                                • Tested At: ${res.batch.tested_at}
                            </div>
                        `;
                    } else {
                        lab2ResultsHtml = `
                            <div class="lab-meta-display" style="background: #fef3c7; border-color: #fde68a; margin-top: 1rem; color: #92400e;">
                                ⚠️ No Lab 2 GCV/Ash test results uploaded yet.
                            </div>
                        `;
                    }

                    resultContent.innerHTML = `
                        <div class="lab-meta-display" style="margin-bottom: 1rem; text-align: center; background: #e0f2fe; color: #0369a1; font-weight: bold; font-size: 1rem;">
                            COMPOSITE LOT: ${res.batch.composite_ref_id}
                        </div>
                        <div style="font-size: 0.9rem; line-height: 1.6; color: var(--text-muted);">
                            <strong>Supplier Name:</strong> ${res.batch.company_name}<br>
                            <strong>Compilation Date:</strong> ${res.batch.date}<br>
                            <strong>Test Lot Barcode ID:</strong> ${res.batch.composite_barcode_id || res.batch.lots?.test || 'N/A'}<br>
                            <strong>Referee Lot Barcode ID:</strong> ${res.batch.lots?.referee || 'N/A'}<br>
                            <strong>Vendor Lot Barcode ID:</strong> ${res.batch.lots?.vendor || 'N/A'}<br>
                            <strong>System Intake Samples Count:</strong> ${res.batch.system_samples_count || (res.matching_trucks ? res.matching_trucks.length : 0)}<br>
                            <strong>Lab Confirmed Mixed Count:</strong> <strong style="color: var(--primary);">${res.batch.mixed_samples_count || (res.matching_trucks ? res.matching_trucks.length : 0)}</strong><br><br>
                            
                            <strong>Mixed Intake Trucks:</strong><br>
                            ${trucksHtml || 'None'}
                        </div>
                        ${lab2ResultsHtml}
                    `;
                }
                
                const displayTitle = res.type === 'sample1' ? 'SAMPLE 1' : 'COMPOSITE LOT';
                setupInspectorReissue(res.barcode_id, displayTitle);
            } else {
                alert('Inspection failed: ' + res.message);
            }
        } catch (err) {
            alert('Lookup error: ' + err.message);
        }
    }

    function setupInspectorReissue(barcodeId, displayTitle) {
        const reissueArea = document.createElement('div');
        reissueArea.style.cssText = 'border-top: 1px dashed #d1d5db; margin-top: 1.5rem; padding-top: 1rem; text-align: center;';
        reissueArea.innerHTML = `
            <button class="btn btn-primary" id="btn-reissue-qr" style="background: #ea580c; border: none; font-weight: bold; width: 100%;">
                🔄 Reissue QR Code
            </button>
            <div id="reissue-preview-area" style="display: none; margin-top: 1rem; padding: 1rem; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb;">
                <div id="reissue-expiry" style="font-size: 0.85rem; margin-bottom: 0.5rem; font-weight: bold;"></div>
                <div style="display: flex; justify-content: center; margin: 10px 0;">
                    <canvas id="qr-canvas-reissue"></canvas>
                </div>
                <div style="display: flex; gap: 0.5rem; justify-content: center; margin-top: 0.5rem;">
                    <button class="btn btn-secondary btn-sm" id="btn-print-reissue">Print</button>
                    <button class="btn btn-primary btn-sm" id="btn-download-reissue">Download</button>
                </div>
            </div>
        `;
        
        const resultContent = document.getElementById('inspector-result-content');
        resultContent.appendChild(reissueArea);

        const btnReissue = document.getElementById('btn-reissue-qr');
        const previewArea = document.getElementById('reissue-preview-area');
        
        btnReissue.onclick = async function() {
            try {
                // 1. Generate encrypted payload
                const encrypted = await encryptPayload(barcodeId);
                previewArea.style.display = 'block';
                
                // 2. Render QR onto canvas
                QRCode.toCanvas(document.getElementById('qr-canvas-reissue'), encrypted, {
                    errorCorrectionLevel: 'H',
                    width: 140,
                    margin: 2
                }, function(err) {
                    if (err) console.error(err);
                });
                
                // 3. Start countdown timer
                const now = Date.now();
                startQrExpiryCountdown(now, 'reissue-expiry');
                
                // 4. Log the reissue activity to spreadsheet backend
                await window.BiomassAPI.logActivity(
                    'Reissue QR', 
                    `QR reissued for ${barcodeId} by admin at ${new Date().toISOString().replace('T', ' ').substring(0, 16)}`
                );
                
                // 5. Setup print and download triggers
                document.getElementById('btn-print-reissue').onclick = function() {
                    const printContainer = document.getElementById('print-section');
                    printContainer.innerHTML = `
                        <div class="print-label-view" style="text-align: center;">
                            <h3 style="font-size: 18pt; font-weight: bold; margin: 0 0 10px 0;">REISSUED: ${displayTitle}</h3>
                            <div>
                                <canvas id="print-qr-target"></canvas>
                            </div>
                            <div style="font-size: 11pt; font-family: monospace; margin-top: 8px;">
                                ${barcodeId}
                            </div>
                        </div>
                    `;
                    QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                        errorCorrectionLevel: 'H',
                        width: 150,
                        margin: 2
                    }, function(err) {
                        if (err) console.error(err);
                        setTimeout(() => { window.print(); }, 200);
                    });
                };
                
                document.getElementById('btn-download-reissue').onclick = function() {
                    downloadQrAsPng(
                        '#qr-canvas-reissue',
                        `Reissued_${barcodeId}`,
                        `REISSUED: ${displayTitle}`,
                        barcodeId
                    );
                };

                alert(`QR code successfully reissued for ${barcodeId} and logged to Activity Log!`);
            } catch (err) {
                alert('Reissue failed: ' + err.message);
            }
        };
    }

    // ================= CORE RUNNER ON LOAD =================
    routeSession();
});
