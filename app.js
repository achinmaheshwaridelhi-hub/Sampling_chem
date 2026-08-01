/**
 * Biomass Sampling - Main Application Controller (app.js)
 * Coordinates user interaction, webcam frames, barcode scanning, print rendering, and reporting.
 */
document.addEventListener('DOMContentLoaded', function() {
    // Current application state
    let activeCameraStream = null;
    let capturedPhotoBase64 = '';

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

    // Fallback simple obfuscation for non-secure contexts (e.g. file:/// protocol)
    function fallbackEncrypt(text) {
        const key = CONFIG.QR_SECRET_KEY || 'BIOMASS_KEY';
        let result = '';
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            result += String.fromCharCode(charCode);
        }
        return 'BSW1F:' + btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fallbackDecrypt(token) {
        if (!token.startsWith('BSW1F:')) {
            throw new Error('Invalid fallback token format');
        }
        const base64Part = token.substring(6);
        let b64 = base64Part.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const text = atob(b64);
        const key = CONFIG.QR_SECRET_KEY || 'BIOMASS_KEY';
        let result = '';
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            result += String.fromCharCode(charCode);
        }
        return { id: result, issuedAt: Date.now(), isFallback: true };
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
        if (!window.crypto || !window.crypto.subtle) {
            return fallbackEncrypt(plainId);
        }
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
        // Fallback for fallback-encrypted codes
        if (token.startsWith('BSW1F:')) {
            try {
                return fallbackDecrypt(token);
            } catch (e) {
                throw new Error('Invalid or corrupt fallback sample QR');
            }
        }
        
        // Fallback for old CODE128 plain-text stock: if not prefixed with BSW1:, return plain ID directly
        if (!token.startsWith('BSW1:')) {
            // Check if it matches a legacy pattern (S1- or CMP-)
            if (token.startsWith('S1-') || token.startsWith('CMP-')) {
                console.log('Legacy plaintext code scanned:', token);
                return { id: token, issuedAt: Date.now(), isLegacy: true };
            }
            throw new Error('Not a valid sample QR code');
        }
        
        if (!window.crypto || !window.crypto.subtle) {
            throw new Error('Standard encrypted QR codes cannot be verified in non-secure offline browser tabs. Please use a secure connection (HTTPS or localhost) or scan local offline barcodes.');
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
        lab2: document.getElementById('screen-lab2'),
        unloading: document.getElementById('screen-unloading')
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
            canvas.width = 600;
            canvas.height = 720;
            
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            let currentY = 40;
            
            // 1. Draw Header Text cleanly wrapped to 2 lines if needed
            if (headerText) {
                context.fillStyle = '#000000';
                context.textAlign = 'center';
                
                let line1 = headerText;
                let line2 = '';
                
                if (headerText.includes('|')) {
                    const parts = headerText.split('|');
                    line1 = parts[0].trim();
                    line2 = parts[1].trim();
                } else if (headerText.includes('—')) {
                    const parts = headerText.split('—');
                    line1 = parts[0].trim();
                    line2 = parts[1].trim();
                } else if (headerText.length > 20) {
                    const spaceIdx = headerText.indexOf(' ', 15);
                    if (spaceIdx > -1) {
                        line1 = headerText.substring(0, spaceIdx).trim();
                        line2 = headerText.substring(spaceIdx).trim();
                    }
                }

                context.font = 'bold 22pt sans-serif';
                context.fillText(line1, canvas.width / 2, currentY);
                currentY += 36;

                if (line2) {
                    context.font = 'bold 18pt sans-serif';
                    context.fillText(line2, canvas.width / 2, currentY);
                    currentY += 34;
                }
            } else {
                currentY = 30;
            }
            
            // 2. Draw QR code image MUCH BIGGER (480x480) with clean white quiet zone
            const qrSize = 480;
            const qrX = (canvas.width - qrSize) / 2;
            context.drawImage(canvasElement, qrX, currentY + 10, qrSize, qrSize);
            
            const png = canvas.toDataURL('image/png');
            const downloadLink = document.createElement('a');
            downloadLink.href = png;
            const safeName = (filename && filename.trim()) ? filename.trim().replace(/[^a-zA-Z0-9_\-]/g, '_') : ('qr_' + Math.random().toString(36).substr(2,9));
            downloadLink.download = `${safeName}.png`;
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
                // Standard image file parsing with multi-engine fallback
                try {
                    const rawReader = new Html5Qrcode(qrReaderId);
                    // Pass 1: Try Html5Qrcode scanFile with internal scaling (renderImage = true) directly on the file
                    const directText = await rawReader.scanFile(file, true);
                    console.log('Successfully scanned using Html5Qrcode scaled scan');
                    successCallback(directText);
                    return;
                } catch (e1) {
                    console.log('Pass 1 direct scaled scan failed, trying image element engines...');
                }

                const fileReader = new FileReader();
                fileReader.onload = function(event) {
                    const img = new Image();
                    img.onload = async function() {
                        // Pass 2: Try Native BarcodeDetector on raw img element
                        if (typeof window.BarcodeDetector !== 'undefined') {
                            try {
                                const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] });
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

                        // Pass 3: Try Html5Qrcode scanFile without scaling
                        try {
                            const rawReader2 = new Html5Qrcode(qrReaderId);
                            const rawText = await rawReader2.scanFile(file, false);
                            console.log('Successfully scanned using Html5Qrcode raw scan');
                            successCallback(rawText);
                            return;
                        } catch (e3) {}

                        // Pass 4: Header-cropped canvas scan (crops out top text header margin)
                        try {
                            const cropY = Math.round(img.height * 0.15); // skip top 15% header text
                            const cropH = img.height - cropY;
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = cropH;

                            const ctx = canvas.getContext('2d');
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, cropY, img.width, cropH, 0, 0, canvas.width, cropH);

                            // Try Native BarcodeDetector on cropped canvas first
                            if (typeof window.BarcodeDetector !== 'undefined') {
                                try {
                                    const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] });
                                    const detected = await detector.detect(canvas);
                                    if (detected && detected.length > 0) {
                                        console.log('Successfully scanned cropped canvas via BarcodeDetector:', detected[0].rawValue);
                                        successCallback(detected[0].rawValue);
                                        return;
                                    }
                                } catch(e) {}
                            }

                            canvas.toBlob(async (blob) => {
                                if (!blob) {
                                    errorCallback('Could not read QR code from this photo.');
                                    return;
                                }
                                const cropFile = new File([blob], "crop-scan.png", { type: "image/png" });
                                try {
                                    const cropReader = new Html5Qrcode(qrReaderId);
                                    const cropText = await cropReader.scanFile(cropFile, true);
                                    console.log('Successfully scanned using cropped canvas blob');
                                    successCallback(cropText);
                                } catch (cropErr) {
                                    // Pass 5: Square QR matrix crop around lower portion
                                    try {
                                        const sqCanvas = document.createElement('canvas');
                                        const sqDim = Math.min(img.width, img.height);
                                        sqCanvas.width = sqDim;
                                        sqCanvas.height = sqDim;
                                        const sqCtx = sqCanvas.getContext('2d');
                                        sqCtx.fillStyle = '#ffffff';
                                        sqCtx.fillRect(0, 0, sqDim, sqDim);
                                        const offsetX = (img.width - sqDim) / 2;
                                        const offsetY = Math.max(0, img.height - sqDim);
                                        sqCtx.drawImage(img, offsetX, offsetY, sqDim, sqDim, 0, 0, sqDim, sqDim);

                                        sqCanvas.toBlob(async (sqBlob) => {
                                            const sqFile = new File([sqBlob], "square-crop.png", { type: "image/png" });
                                            try {
                                                const sqReader = new Html5Qrcode(qrReaderId);
                                                const sqText = await sqReader.scanFile(sqFile, true);
                                                console.log('Successfully scanned using square crop canvas');
                                                successCallback(sqText);
                                            } catch(sqErr) {
                                                errorCallback('Could not read QR code or barcode from this photo. Please make sure the photo is well-lit and the code is not skewed or blurry.');
                                            }
                                        }, "image/png");
                                    } catch(e5) {
                                        errorCallback('Could not read QR code or barcode from this photo.');
                                    }
                                }
                            }, "image/png");
                        } catch (err4) {
                            errorCallback('Could not read QR code or barcode from this photo.');
                        }
                    };
                    img.src = event.target.result;
                };
                fileReader.readAsDataURL(file);
            }
        } catch (err) {
            errorCallback('Failed to decode uploaded file: ' + err.message);
        }
    }





    // ================= UN IFIED CAMERA QR / BARCODE SCANNER =================
    // Single implementation used by every station: rear camera, continuous
    // autofocus, torch toggle, large scan window and native BarcodeDetector
    // acceleration where the device supports it.
    const activeScanners = {};
    const scannerStoppers = {};

    function supportedScanFormats() {
        if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
        return [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.DATA_MATRIX
        ];
    }

    async function stopSharedScanner(key) {
        const stopper = scannerStoppers[key];
        if (stopper) {
            await stopper();
        }
    }

    async function stopAllSharedScanners() {
        for (const key of Object.keys(scannerStoppers)) {
            try { await scannerStoppers[key](); } catch (e) {}
        }
    }

    function setupSharedCameraScanner(cfg) {
        const trigger = document.getElementById(cfg.triggerId);
        const container = document.getElementById(cfg.containerId);
        const btnStop = document.getElementById(cfg.stopBtnId);
        const btnTorch = cfg.torchBtnId ? document.getElementById(cfg.torchBtnId) : null;
        if (!trigger || !container) return;

        // Create Capture & Scan Button dynamically
        let btnCapture = container.querySelector('.btn-capture-scan');
        if (!btnCapture) {
            btnCapture = document.createElement('button');
            btnCapture.type = 'button';
            btnCapture.className = 'btn btn-primary btn-sm btn-capture-scan';
            btnCapture.style.width = '100%';
            btnCapture.style.marginTop = '0.5rem';
            btnCapture.style.display = 'none';
            btnCapture.textContent = '📸 Capture & Scan Static Frame';
            if (btnStop) {
                container.insertBefore(btnCapture, btnStop);
            } else {
                container.appendChild(btnCapture);
            }
        }

        // Create Snap Photo / Upload Image Button and Input dynamically
        let btnUpload = trigger.parentNode.querySelector('.btn-upload-scan-' + cfg.key);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.setAttribute('capture', 'environment');
        fileInput.style.display = 'none';
        
        if (!btnUpload) {
            btnUpload = document.createElement('button');
            btnUpload.type = 'button';
            btnUpload.className = 'btn btn-secondary btn-sm btn-upload-scan-' + cfg.key;
            btnUpload.style.width = '100%';
            btnUpload.style.marginTop = '0.5rem';
            btnUpload.style.padding = '0.5rem';
            btnUpload.style.fontSize = '0.9rem';
            btnUpload.style.fontWeight = 'bold';
            btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
            
            // Insert it right after trigger
            trigger.parentNode.insertBefore(btnUpload, trigger.nextSibling);
            trigger.parentNode.insertBefore(fileInput, btnUpload);
        } else {
            const oldInput = trigger.parentNode.querySelector('input[type="file"][capture="environment"]');
            if (oldInput) {
                oldInput.parentNode.removeChild(oldInput);
            }
            trigger.parentNode.insertBefore(fileInput, btnUpload);
        }

        btnUpload.onclick = function() {
            fileInput.click();
        };

        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            try {
                btnUpload.textContent = '⏳ Processing Image...';
                const tempScanner = new Html5Qrcode(cfg.readerId);
                const decodedText = await tempScanner.scanFile(file, false);
                btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
                await cfg.onDecode(decodedText);
            } catch (err) {
                btnUpload.textContent = '📷 Snap Photo / Upload Image to Scan';
                alert('Barcode scan failed: Could not detect barcode from the uploaded photo. Please make sure the QR code/barcode is clear, close-up, and well-lit, then try again.');
            }
            fileInput.value = '';
        };

        let torchOn = false;

        async function stopScanning() {
            const scanner = activeScanners[cfg.key];
            if (scanner) {
                try { await scanner.stop(); } catch (e) {}
                try { scanner.clear(); } catch (e) {}
                activeScanners[cfg.key] = null;
            }
            torchOn = false;
            if (btnTorch) btnTorch.textContent = 'Torch On / Off';
            if (btnCapture) btnCapture.style.display = 'none';
            container.style.display = 'none';
            trigger.style.display = 'flex';
        }
        scannerStoppers[cfg.key] = stopScanning;

        btnCapture.onclick = async function() {
            const scanner = activeScanners[cfg.key];
            if (!scanner) return;

            const video = container.querySelector('video');
            if (!video) {
                alert("Camera feed is not ready yet.");
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || video.clientWidth;
            canvas.height = video.videoHeight || video.clientHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            await stopScanning();

            canvas.toBlob(async function(blob) {
                if (!blob) {
                    alert("Failed to capture image frame.");
                    return;
                }
                try {
                    const tempScanner = new Html5Qrcode(cfg.readerId);
                    const decodedText = await tempScanner.scanFile(blob, false);
                    await cfg.onDecode(decodedText);
                } catch (err) {
                    alert('Barcode scan failed: Could not detect barcode from the captured picture. Please make sure the barcode is in clear focus and try again.');
                }
            }, 'image/jpeg');
        };

        trigger.onclick = async function() {
            container.style.display = 'block';
            trigger.style.display = 'none';
            if (btnCapture) btnCapture.style.display = 'inline-block';

            let scanner;
            try {
                scanner = new Html5Qrcode(cfg.readerId, {
                    formatsToSupport: supportedScanFormats(),
                    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                    verbose: false
                });
            } catch (e) {
                scanner = new Html5Qrcode(cfg.readerId);
            }
            activeScanners[cfg.key] = scanner;

            // Common scanner options
            const scanOptions = {
                fps: 20,
                qrbox: function(viewfinderWidth, viewfinderHeight) {
                    const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.85);
                    return { width: edge, height: edge };
                },
                formatsToSupport: supportedScanFormats(),
                experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                disableFlip: false
            };

            const successCallback = async function(decodedText) {
                await stopScanning();
                try {
                    await cfg.onDecode(decodedText);
                } catch (e) {
                    alert(e.message || e);
                }
            };
            const errorCallback = function() { /* per-frame decode misses are expected */ };

            try {
                // Try rear/environment camera first
                await scanner.start({ facingMode: "environment" }, scanOptions, successCallback, errorCallback);
                
                // Continuous autofocus where hardware exposes it
                try {
                    await scanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] });
                } catch (e) {}

                // Torch availability
                if (btnTorch) {
                    let torchSupported = false;
                    try {
                        const caps = scanner.getRunningTrackCapabilities();
                        torchSupported = !!(caps && caps.torch);
                    } catch (e) {}
                    btnTorch.style.display = torchSupported ? 'inline-block' : 'none';
                }
            } catch (err) {
                console.warn('Failed starting with environment camera, retrying with default user camera...', err);
                try {
                    // Fallback to default user camera (e.g. laptop webcam)
                    await scanner.start({}, scanOptions, successCallback, errorCallback);
                } catch (retryErr) {
                    alert('Error opening camera scanner: ' + (retryErr.message || retryErr) + '\n\nPlease scan using a USB scanner or type the code manually.');
                    await stopScanning();
                }
            }
        };

        if (btnTorch) {
            btnTorch.onclick = async function() {
                const scanner = activeScanners[cfg.key];
                if (!scanner) return;
                try {
                    torchOn = !torchOn;
                    await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
                    btnTorch.textContent = torchOn ? 'Torch Off' : 'Torch On';
                } catch (e) {
                    torchOn = false;
                    alert('Torch is not available on this device camera.');
                }
            };
        }

        if (btnStop) {
            btnStop.onclick = stopScanning;
            btnStop.style.display = 'inline-block';
        }
    }

    function setupLab1CameraScanner() {
        setupSharedCameraScanner({
            key: 'lab1',
            triggerId: 'lab1-scan-trigger',
            containerId: 'lab1-scanner-container',
            readerId: 'lab1-qr-reader',
            stopBtnId: 'btn-lab1-stop-scan',
            torchBtnId: 'btn-lab1-torch',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('lab1-manual-input').value = plainId;
                lookupLab1Barcode(plainId);
            }
        });
    }

    function setupLab2CameraScanner() {
        setupSharedCameraScanner({
            key: 'lab2',
            triggerId: 'lab2-scan-trigger',
            containerId: 'lab2-scanner-container',
            readerId: 'lab2-qr-reader',
            stopBtnId: 'btn-lab2-stop-scan',
            torchBtnId: 'btn-lab2-torch',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('lab2-manual-input').value = plainId;
                lookupLab2Barcode(plainId);
            }
        });
    }

    function setupInspectorCameraScanner() {
        setupSharedCameraScanner({
            key: 'inspector',
            triggerId: 'inspector-scan-trigger',
            containerId: 'inspector-scanner-container',
            readerId: 'inspector-qr-reader',
            stopBtnId: 'btn-inspector-stop-scan',
            torchBtnId: 'btn-inspector-torch',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('inspector-manual-input').value = plainId;
                lookupInspectorBarcode(plainId);
            }
        });
    }

    function setupUnloadingCameraScanner() {
        setupSharedCameraScanner({
            key: 'unloading',
            triggerId: 'unloading-scan-trigger',
            containerId: 'unloading-scanner-container',
            readerId: 'unloading-qr-reader',
            stopBtnId: 'btn-unloading-stop-scan',
            torchBtnId: 'btn-unloading-torch',
            onDecode: async function(decodedText) {
                const plainId = await processScannedCode(decodedText);
                document.getElementById('unloading-manual-input').value = plainId;
                lookupUnloadingStatus(plainId);
            }
        });
    }


    // ================= AFTER WEIGHMENT / UNLOADING AREA =================
    function initUnloadingScreen() {
        setupUnloadingCameraScanner();
        renderUnloadingLog();

        const btn = document.getElementById('btn-unloading-lookup');
        const input = document.getElementById('unloading-manual-input');
        if (btn) btn.onclick = () => lookupUnloadingStatus(input.value.trim());
        if (input) input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); lookupUnloadingStatus(input.value.trim()); }
        };

        const unloadingTare = document.getElementById('unloading-weight-tare');
        if (unloadingTare) {
            unloadingTare.oninput = calculateUnloadingNet;
        }

        const unloadingForm = document.getElementById('unloading-weight-form');
        if (unloadingForm) {
            unloadingForm.onsubmit = async function(e) {
                e.preventDefault();
                const id = document.getElementById('unloading-weight-truck-id').value;
                const gross = document.getElementById('unloading-weight-gross').value;
                const tare = unloadingTare.value;

                try {
                    const res = await window.BiomassAPI.updateWeighment(id, gross, tare);
                    if (res.success) {
                        alert('Final weight submitted and entry updated successfully.');
                        document.getElementById('unloading-result-card').style.display = 'none';
                        renderUnloadingLog();
                    } else {
                        alert('Submission failed: ' + res.message);
                    }
                } catch (err) {
                    alert('Communication error: ' + err.message);
                }
            };
        }
    }

    function calculateUnloadingNet() {
        const gross = Number(document.getElementById('unloading-weight-gross').value) || 0;
        const tare = Number(document.getElementById('unloading-weight-tare').value) || 0;
        const net = gross > tare ? (gross - tare) : 0;
        const netDisplay = document.getElementById('unloading-weight-net');
        if (netDisplay) {
            netDisplay.textContent = `${net.toLocaleString()} kg`;
        }
    }

    async function lookupUnloadingStatus(code) {
        if (!code) return;
        const card = document.getElementById('unloading-result-card');
        const banner = document.getElementById('unloading-status-banner');
        const body = document.getElementById('unloading-detail-body');
        card.style.display = 'block';
        banner.style.display = 'block';
        banner.className = 'alert';
        banner.textContent = 'Checking consignment status...';
        body.innerHTML = '';
        try {
            const plainId = await processScannedCode(code);
            const res = await window.BiomassAPI.getUnloadingStatus(plainId);
            if (!res || res.success === false) throw new Error((res && res.message) || 'Truck not found.');

            const status = res.acceptance_status;
            const weightFormContainer = document.getElementById('unloading-weight-form-container');
            
            if (status === 'ACCEPTED') {
                banner.className = 'alert alert-success';
                banner.style.border = '2px solid #16a34a';
                banner.style.boxShadow = 'none';
                banner.innerHTML = '<strong>UNLOADING ALLOWED</strong><br>Material accepted. Proceed with unloading.';
                
                // Show weight form to enter Tare Weight
                if (weightFormContainer) {
                    weightFormContainer.style.display = 'block';
                    document.getElementById('unloading-weight-truck-id').value = res.truck_id;
                    document.getElementById('unloading-weight-gross').value = res.gross_weight || 0;
                    document.getElementById('unloading-weight-tare').value = res.tare_weight || '';
                    calculateUnloadingNet();
                }
            } else {
                if (status === 'REJECTED') {
                    banner.className = 'alert alert-danger';
                    banner.style.border = '2px solid #dc2626';
                    banner.style.boxShadow = '0 0 12px #ef4444';
                    banner.innerHTML = `
                        <div style="font-size: 1.25rem; font-weight: 800; color: #ef4444; margin-bottom: 0.5rem; text-align: center; text-transform: uppercase;">
                            ⚠️ REJECTED CONSIGNMENT ⚠️
                        </div>
                        <div style="font-size: 1.1rem; font-weight: 700; margin-bottom: 0.5rem; text-align: center;">
                            TRUCK NO: <span style="background: #ef4444; color: white; padding: 0.2rem 0.6rem; border-radius: 4px; border: 1px solid #ffffff; font-size: 1.2rem; display: inline-block; margin-top: 0.25rem;">${res.truck_reg_number}</span>
                        </div>
                        <strong>UNLOADING STRICTLY FORBIDDEN</strong><br>
                        Moisture level is <strong>${res.moisture_pct}%</strong> (Maximum allowed: ${res.moisture_limit}%). Net weight is recorded as 0. Do not unload this truck.
                    `;
                } else {
                    banner.className = 'alert alert-warning';
                    banner.style.border = '2px solid #ca8a04';
                    banner.style.boxShadow = 'none';
                    banner.innerHTML = '<strong>PENDING — DO NOT UNLOAD</strong><br>Lab testing is not complete for this truck yet.';
                }
                
                if (weightFormContainer) {
                    weightFormContainer.style.display = 'none';
                }
            }

            const rows = [
                ['Truck ID', `<strong>${res.truck_id}</strong>`],
                ['Vehicle Reg.', status === 'REJECTED' ? `<span style="background: #ef4444; color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: bold; border: 1px solid white;">${res.truck_reg_number} (REJECTED)</span>` : `<strong>${res.truck_reg_number}</strong>`],
                ['Invoice / Challan No.', res.invoice_no || res.challan_no || '-'],
                ['Supplier', res.company_name],
                ['Driver', res.driver_name],
                ['Mixing Group', res.daily_group_code || '-'],
                ['Moisture %', res.moisture_pct === null ? 'Pending' : (status === 'REJECTED' ? `<strong style="color: #ef4444; font-size: 1.1rem;">${res.moisture_pct}% (Overlimit)</strong>` : `${res.moisture_pct}%`)],
                ['Fineness %', res.fineness_value === null ? 'Pending' : `${res.fineness_value}%`],
                ['Net Weight (kg)', res.net_weight],
                ['Acceptance Status', status === 'REJECTED' ? `<span class="badge badge-danger" style="animation: pulse 1s infinite; font-size: 0.9rem; padding: 0.25rem 0.5rem; display: inline-block;">REJECTED</span>` : `<span class="badge ${status === 'ACCEPTED' ? 'badge-success' : 'badge-warning'}">${status}</span>`]
            ];
            body.innerHTML = rows.map(r => `<tr><th style="text-align:left;">${r[0]}</th><td>${r[1]}</td></tr>`).join('');
        } catch (err) {
            banner.className = 'alert alert-danger';
            banner.textContent = err.message;
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
        } else if (user.role === 'lab1' || user.role === 'lab1m' || user.role === 'lab1f') {
            screens.lab1.classList.add('active');
            initLab1Screen();
        } else if (user.role === 'unloading') {
            screens.unloading.classList.add('active');
            initUnloadingScreen();
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

    function sha256_pure(ascii) {
        function safeAdd(x, y) {
            var lsw = (x & 0xFFFF) + (y & 0xFFFF);
            var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
            return (msw << 16) | (lsw & 0xFFFF);
        }
        function S(X, n) { return (X >>> n) | (X << (32 - n)); }
        function R(X, n) { return X >>> n; }
        function Ch(x, y, z) { return ((x & y) ^ (~x & z)); }
        function Maj(x, y, z) { return ((x & y) ^ (x & z) ^ (y & z)); }
        function Sigma0256(x) { return S(x, 2) ^ S(x, 13) ^ S(x, 22); }
        function Sigma1256(x) { return S(x, 6) ^ S(x, 11) ^ S(x, 25); }
        function Gamma0256(x) { return S(x, 7) ^ S(x, 18) ^ R(x, 3); }
        function Gamma1256(x) { return S(x, 17) ^ S(x, 19) ^ R(x, 10); }

        var H = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];

        var words = [];
        var i;
        var asciiLength = ascii.length;
        for (i = 0; i < asciiLength; i++) {
            words[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
        }
        words[asciiLength >> 2] |= 0x80 << (24 - (asciiLength % 4) * 8);
        
        var blockCount = ((asciiLength + 8) >> 6) + 1;
        var wordCount = blockCount * 16;
        for (i = (asciiLength >> 2) + 1; i < wordCount; i++) {
            words[i] = 0;
        }
        words[wordCount - 2] = (asciiLength * 8) >>> 16;
        words[wordCount - 1] = (asciiLength * 8) & 0xffffffff;

        for (var b = 0; b < blockCount; b++) {
            var W = [];
            for (i = 0; i < 16; i++) {
                W[i] = words[b * 16 + i];
            }
            for (i = 16; i < 64; i++) {
                W[i] = safeAdd(safeAdd(safeAdd(Gamma1256(W[i - 2]), W[i - 7]), Gamma0256(W[i - 15])), W[i - 16]);
            }

            var a = H[0], d = H[3], e = H[4], h = H[7];
            var b_val = H[1], c_val = H[2], f_val = H[5], g_val = H[6];
            for (i = 0; i < 64; i++) {
                var T1 = safeAdd(safeAdd(safeAdd(safeAdd(h, Sigma1256(e)), Ch(e, f_val, g_val)), K[i]), W[i]);
                var T2 = safeAdd(Sigma0256(a), Maj(a, b_val, c_val));
                
                h = g_val; g_val = f_val; f_val = e;
                e = safeAdd(d, T1);
                d = c_val; c_val = b_val; b_val = a;
                a = safeAdd(T1, T2);
            }

            H[0] = safeAdd(H[0], a);
            H[1] = safeAdd(H[1], b_val);
            H[2] = safeAdd(H[2], c_val);
            H[3] = safeAdd(H[3], d);
            H[4] = safeAdd(H[4], e);
            H[5] = safeAdd(H[5], f_val);
            H[6] = safeAdd(H[6], g_val);
            H[7] = safeAdd(H[7], h);
        }

        var result = "";
        for (i = 0; i < 8; i++) {
            var hex = (H[i] >>> 0).toString(16);
            while (hex.length < 8) hex = "0" + hex;
            result += hex;
        }
        return result;
    }

    // Helper to calculate SHA-256 of text
    async function hashPassword(password) {
        if (window.crypto && window.crypto.subtle) {
            try {
                const encoder = new TextEncoder();
                const data = encoder.encode(password);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (err) {
                console.warn('Crypto Subtle hashing failed, falling back to pure JS...', err);
                return sha256_pure(password);
            }
        } else {
            return sha256_pure(password);
        }
    }

    // Handle Login Submit
    const loginForm = document.getElementById('login-form');
    const loginAlert = document.getElementById('login-alert');

    window.showGlobalLoader = function(msg) {
        const loader = document.getElementById('global-loader');
        const text = document.getElementById('loader-message');
        if (text) text.textContent = msg || 'Loading Terminal Data...';
        if (loader) loader.style.display = 'flex';
    };

    window.hideGlobalLoader = function() {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    };

    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        loginAlert.style.display = 'none';
        
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        showGlobalLoader('Authenticating credentials & loading dashboard...');

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
        } finally {
            hideGlobalLoader();
        }
    });

    // Helper: Stop camera streams and QR readers
    async function stopAllCameras() {
        if (activeCameraStream) {
            activeCameraStream.getTracks().forEach(track => track.stop());
            activeCameraStream = null;
        }
        await stopAllSharedScanners();
        const camPanel = document.getElementById('camera-stream-panel');
        if (camPanel) camPanel.style.display = 'none';
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

        if (role === 'admin' || role === 'entry') {
            loadRecentRegistrations();
        }

        if (role === 'admin') {
            const activeTab = document.querySelector('#screen-admin .tab-btn.active');
            const dataTab = activeTab ? activeTab.getAttribute('data-tab') : 'admin-dashboard';
            if (dataTab === 'admin-dashboard') {
                initExecutiveDashboard();
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
            const targetContentId = `tab-${clickedTab.getAttribute('data-tab')}`;

            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            clickedTab.classList.add('active');
            const targetEl = document.getElementById(targetContentId);
            if (targetEl) targetEl.classList.add('active');

            // Hook for refreshing specific tabs on click
            if (targetContentId === 'tab-admin-dashboard') {
                initExecutiveDashboard();
            } else if (targetContentId === 'tab-admin-weighment') {
                renderWeighmentLog();
            } else if (targetContentId === 'tab-admin-composite') {
                loadCompositeSelectors();
            } else if (targetContentId === 'tab-admin-reports') {
                loadReportSelectors();
            } else if (targetContentId === 'tab-admin-inspector') {
                initAdminInspectorTab();
            } else if (targetContentId === 'tab-admin-referee') {
                loadRefereeChallengeTable();
            } else if (targetContentId === 'tab-admin-activity') {
                renderActivityLogTab();
            }
        }

        // Initialize Registration view options
        loadSupplierDataLists();
        setupRegistrationCamera();
    }

    // ================= ADMIN: REFEREE CHALLENGE TAB =================
    let allRefereeCompositeBatches = [];

    async function loadRefereeChallengeTable() {
        const tbody = document.getElementById('referee-challenge-table-body');
        const countSpan = document.getElementById('referee-records-count');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Loading composite lot history...</td></tr>';

        try {
            const activeUser = window.BiomassAPI.getCurrentUser();
            let batches = [];
            if (window.BiomassAPI.isRemoteMode()) {
                const res = await fetch(`${window.BiomassAPI.getAppsScriptUrl()}?action=getComposites&role=${activeUser.role}`);
                const data = await res.json();
                batches = data.batches || [];
            } else {
                batches = window.BiomassAPI.getDB().composite_batches || [];
            }

            allRefereeCompositeBatches = batches;
            renderRefereeTableRows(batches);
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger); padding: 1.5rem;">Failed to load composite history: ${err.message}</td></tr>`;
        }
    }

    function renderRefereeTableRows(batches) {
        const tbody = document.getElementById('referee-challenge-table-body');
        const countSpan = document.getElementById('referee-records-count');
        if (!tbody) return;

        const searchVal = (document.getElementById('referee-search-input')?.value || '').trim().toLowerCase();
        
        let filtered = batches;
        if (searchVal) {
            filtered = batches.filter(b => {
                const group = String(b.daily_group_code || '').toLowerCase();
                const ref = String(b.composite_ref_id || '').toLowerCase();
                const company = String(b.company_name || '').toLowerCase();
                const date = String(b.date || '').toLowerCase();
                return group.includes(searchVal) || ref.includes(searchVal) || company.includes(searchVal) || date.includes(searchVal);
            });
        }

        if (countSpan) countSpan.textContent = `Showing ${filtered.length} composite lots`;
        tbody.innerHTML = '';

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No matching composite lots found.</td></tr>';
            return;
        }

        filtered.forEach(batch => {
            const tr = document.createElement('tr');

            const refId = batch.composite_ref_id || batch.daily_group_code || 'N/A';
            const groupCode = batch.daily_group_code || refId;
            const companyName = batch.company_name || 'N/A';
            const sampleDate = batch.date || 'N/A';

            // 1. NTPC GCV
            const ntpcGcv = (batch.gcv_value !== null && batch.gcv_value !== undefined && batch.gcv_value !== "") 
                ? `<strong>${batch.gcv_value}</strong> kcal/kg` 
                : '<span style="color: #94a3b8; font-style: italic;">Pending Lab 2</span>';

            // 2. Vendor GCV
            const hasVendorGcv = (batch.vendor_gcv !== null && batch.vendor_gcv !== undefined && batch.vendor_gcv !== "");
            let vendorGcvHtml = '';
            if (hasVendorGcv) {
                vendorGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="number" value="${batch.vendor_gcv}" disabled style="width: 100px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid #cbd5e1; background: var(--bg-card); font-weight: bold; color: var(--text-color);">
                        <span class="badge badge-success" style="font-size: 0.75rem;">Locked</span>
                    </div>
                `;
            } else {
                vendorGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" id="input-vendor-gcv-${refId}" placeholder="e.g. 4300" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color);">
                        <button class="btn btn-primary btn-sm btn-save-vendor-gcv" data-ref-id="${refId}" style="padding: 0.35rem 0.6rem; font-size: 0.8rem;">Save</button>
                    </div>
                `;
            }

            // 3. Challenge Status & Trigger Button
            const isChallenged = (batch.referee_status === 'CHALLENGED' || batch.referee_status === 'RESOLVED');
            const isResolved = (batch.referee_status === 'RESOLVED' || (batch.referee_gcv !== null && batch.referee_gcv !== undefined && batch.referee_gcv !== ""));

            let challengeBtnHtml = '';
            if (!hasVendorGcv) {
                challengeBtnHtml = '<span style="color: #94a3b8; font-size: 0.85rem; font-style: italic;">Enter Vendor GCV first</span>';
            } else if (!isChallenged) {
                challengeBtnHtml = `
                    <button class="btn btn-warning btn-sm btn-trigger-challenge" data-ref-id="${refId}" style="background: #ea580c; border: none; color: white; font-weight: bold; padding: 0.4rem 0.75rem;">
                        ⚖️ Challenge Referee
                    </button>
                `;
            } else {
                challengeBtnHtml = `<span class="badge badge-warning" style="background: #f59e0b; color: white; font-weight: bold;">Referee Challenged</span>`;
            }

            // 4. Referee GCV
            let refereeGcvHtml = '';
            if (isResolved) {
                refereeGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="number" value="${batch.referee_gcv}" disabled style="width: 100px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid #10b981; background: rgba(16, 185, 129, 0.1); font-weight: bold; color: #047857;">
                        <span class="badge badge-success" style="font-size: 0.75rem;">Locked</span>
                    </div>
                `;
            } else if (isChallenged) {
                refereeGcvHtml = `
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" id="input-referee-gcv-${refId}" placeholder="e.g. 4320" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color);">
                        <button class="btn btn-success btn-sm btn-save-referee-gcv" data-ref-id="${refId}" style="padding: 0.35rem 0.6rem; font-size: 0.8rem; background: #10b981; border: none;">Save</button>
                    </div>
                `;
            } else {
                refereeGcvHtml = '<input type="number" disabled placeholder="Locked" style="width: 95px; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-card); opacity: 0.5;">';
            }

            // 5. Overall Status Badge
            let statusBadgeHtml = '';
            if (isResolved) {
                statusBadgeHtml = '<span class="badge badge-success" style="background: #10b981; color: white;">Referee Resolved</span>';
            } else if (isChallenged) {
                statusBadgeHtml = '<span class="badge badge-warning" style="background: #f59e0b; color: white;">Challenge Pending</span>';
            } else if (hasVendorGcv) {
                statusBadgeHtml = '<span class="badge badge-info" style="background: #3b82f6; color: white;">Ready for Challenge</span>';
            } else {
                statusBadgeHtml = '<span class="badge badge-pending" style="background: #64748b; color: white;">Pending Vendor GCV</span>';
            }

            tr.innerHTML = `
                <td><span class="badge badge-referee" style="font-weight: bold; font-size: 0.9rem;">${groupCode}</span></td>
                <td><strong>${companyName}</strong></td>
                <td>${sampleDate}</td>
                <td>${ntpcGcv}</td>
                <td>${vendorGcvHtml}</td>
                <td>${challengeBtnHtml}</td>
                <td>${refereeGcvHtml}</td>
                <td>${statusBadgeHtml}</td>
            `;

            tbody.appendChild(tr);
        });

        // Attach Event Listeners
        document.querySelectorAll('.btn-save-vendor-gcv').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const valInput = document.getElementById(`input-vendor-gcv-${refId}`);
                const val = valInput ? valInput.value.trim() : '';

                if (!val || isNaN(val) || Number(val) <= 0) {
                    alert('Please enter a valid Vendor GCV value (kcal/kg).');
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.textContent = 'Saving...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { vendorGcv: Number(val) });
                    alert(`Vendor GCV (${val} kcal/kg) saved and locked successfully!`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to save Vendor GCV: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            };
        });

        document.querySelectorAll('.btn-trigger-challenge').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const confirmChoice = confirm(`Are you sure you want to flag Mixing Group / Lot "${refId}" for REFEREE CHALLENGE?\n\nThis will unlock the Referee GCV field for entering third-party test results.`);
                if (!confirmChoice) return;

                try {
                    btn.disabled = true;
                    btn.textContent = 'Challenging...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { refereeStatus: 'CHALLENGED' });
                    alert(`Lot "${refId}" is now flagged for Referee Challenge! You can now enter the third-party Referee GCV.`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to trigger Referee Challenge: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = '⚖️ Challenge Referee';
                }
            };
        });

        document.querySelectorAll('.btn-save-referee-gcv').forEach(btn => {
            btn.onclick = async function() {
                const refId = btn.getAttribute('data-ref-id');
                const valInput = document.getElementById(`input-referee-gcv-${refId}`);
                const val = valInput ? valInput.value.trim() : '';

                if (!val || isNaN(val) || Number(val) <= 0) {
                    alert('Please enter a valid Referee GCV value (kcal/kg).');
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.textContent = 'Saving...';
                    await window.BiomassAPI.updateRefereeChallenge(refId, { refereeGcv: Number(val), refereeStatus: 'RESOLVED' });
                    alert(`Referee GCV (${val} kcal/kg) saved and locked successfully! Lot challenge is now resolved.`);
                    await loadRefereeChallengeTable();
                } catch (err) {
                    alert('Failed to save Referee GCV: ' + err.message);
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            };
        });
    }

    document.getElementById('btn-refresh-referee')?.addEventListener('click', loadRefereeChallengeTable);
    document.getElementById('referee-search-input')?.addEventListener('input', () => {
        renderRefereeTableRows(allRefereeCompositeBatches);
    });

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

    async function loadRecentRegistrations() {
        const user = window.BiomassAPI.getCurrentUser();
        if (!user) return;
        
        const tbody = document.getElementById('recent-reg-table-body');
        if (!tbody) return;
        
        try {
            const trucks = await window.BiomassAPI.getTrucks();
            
            // Filter based on role
            let filtered = [];
            if (user.role === 'entry') {
                const todayStr = new Date().toISOString().substring(0, 10);
                filtered = trucks.filter(t => t.entry_date === todayStr);
            } else {
                // admin sees everything
                filtered = trucks;
            }
            
            // Sort newest registrations first
            filtered.sort((a, b) => {
                const dateA = new Date(a.entry_date + 'T' + a.entry_time);
                const dateB = new Date(b.entry_date + 'T' + b.entry_time);
                return dateB - dateA;
            });
            
            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No registered trucks found.</td></tr>`;
                return;
            }
            
            tbody.innerHTML = '';
            filtered.forEach(truck => {
                const tr = document.createElement('tr');
                
                // Actions column
                const tdActions = document.createElement('td');
                
                const btnView = document.createElement('button');
                btnView.className = 'btn btn-secondary btn-sm';
                btnView.style.marginRight = '0.25rem';
                btnView.textContent = 'View';
                btnView.onclick = async () => {
                    const encrypted = await encryptPayload(truck.sample1_barcode_id);
                    document.getElementById('s1-group-code-display').textContent = `MIXING GROUP: ${truck.daily_group_code || 'N/A'}`;
                    
                    // Render code
                    if (typeof JsBarcode !== 'undefined') {
                        JsBarcode(document.getElementById('qr-canvas-s1'), encrypted, {
                            format: "CODE128", width: 2, height: 60, displayValue: false
                        });
                    } else {
                        QRCode.toCanvas(document.getElementById('qr-canvas-s1'), encrypted, {
                            errorCorrectionLevel: 'H', width: 180, margin: 2
                        });
                    }
                    
                    document.getElementById('admin-barcodes-result').style.display = 'block';
                    setupBarcodePrintTriggers(truck.sample1_barcode_id, truck.daily_group_code);
                    
                    // Scroll view into display
                    document.getElementById('admin-barcodes-result').scrollIntoView({ behavior: 'smooth' });
                };
                
                const btnPrint = document.createElement('button');
                btnPrint.className = 'btn btn-primary btn-sm';
                btnPrint.textContent = 'Print';
                btnPrint.onclick = async () => {
                    const encrypted = await encryptPayload(truck.sample1_barcode_id);
                    const printContainer = document.getElementById('print-section');
                    printContainer.innerHTML = `
                        <div class="print-label-view" style="text-align: center;">
                            <div style="font-size: 14pt; font-weight: bold; border: 2px solid black; padding: 4px 10px; margin-bottom: 8px; display: inline-block;">
                                MIXING GROUP: ${truck.daily_group_code || 'N/A'}
                            </div>
                            <div>
                                <canvas id="print-qr-target"></canvas>
                            </div>
                        </div>
                    `;
                    
                    if (typeof JsBarcode !== 'undefined') {
                        JsBarcode(document.getElementById('print-qr-target'), encrypted, {
                            format: "CODE128", width: 2.7, height: 65, displayValue: false
                        });
                        setTimeout(() => { window.print(); }, 200);
                    } else {
                        QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                            errorCorrectionLevel: 'H', width: 230, margin: 2
                        }, function(err) {
                            if (err) console.error(err);
                            setTimeout(() => { window.print(); }, 200);
                        });
                    }
                };
                
                tdActions.appendChild(btnView);
                tdActions.appendChild(btnPrint);
                
                const chNo = truck.invoice_no || truck.challan_no || '-';
                tr.innerHTML = `
                    <td style="font-weight: bold;">${truck.truck_id}</td>
                    <td>${truck.entry_date} ${truck.entry_time.substring(0, 5)}</td>
                    <td>${truck.company_name}</td>
                    <td>${truck.truck_reg_number}</td>
                    <td><span style="font-family: monospace;">${chNo}</span></td>
                    <td>${truck.driver_name}</td>
                    <td><span class="badge badge-complete">${truck.daily_group_code || 'N/A'}</span></td>
                `;
                tr.appendChild(tdActions);
                tbody.appendChild(tr);
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger);">Failed to load recent registrations: ${err.message}</td></tr>`;
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
            invoice_no: document.getElementById('reg-invoice').value.trim(),
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


            document.getElementById('admin-barcodes-result').style.display = 'block';
            
            // Attach print & download triggers (Only S1 QR)
            setupBarcodePrintTriggers(truck.sample1_barcode_id, truck.daily_group_code);

            // Clean registration form
            truckRegForm.reset();
            document.getElementById('btn-delete-photo').click(); 
            loadSupplierDataLists(); 
            loadRecentRegistrations();
            
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
                    <div style="font-size: 14pt; font-weight: bold; border: 2px solid black; padding: 4px 10px; margin-bottom: 8px; display: inline-block;">
                        MIXING GROUP: ${dailyGroupCode || 'N/A'}
                    </div>
                    <div>
                        <canvas id="print-qr-target"></canvas>
                    </div>
                </div>
            `;
            QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                errorCorrectionLevel: 'H',
                width: 230,
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
        if (window.showGlobalLoader) window.showGlobalLoader('Fetching Weighment Log...');
        
        try {
            const trucks = await window.BiomassAPI.getTrucks();
            const filter = searchWeighInput.value.toLowerCase().trim();
            tbody.innerHTML = '';

            const filtered = trucks.filter(t => {
                const id = String(t.truck_id || '').toLowerCase();
                const comp = String(t.company_name || '').toLowerCase();
                const reg = String(t.truck_reg_number || '').toLowerCase();
                return id.includes(filter) || comp.includes(filter) || reg.includes(filter);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">No matching truck entries found today.</td></tr>';
                return;
            }

            filtered.slice().reverse().forEach(truck => {
                const tr = document.createElement('tr');
                
                const hasPhoto = truck.has_photo || !!truck.photo_url;
                const photoHtml = hasPhoto 
                    ? `<span style="font-size:0.75rem; color:#10b981; font-weight:bold;">📸 Attached</span>`
                    : '<span style="font-size: 0.75rem; color: #f87171;">No Photo</span>';

                const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
                const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);

                const chNo = truck.invoice_no || truck.challan_no || '-';
                const activeUser = window.BiomassAPI.getCurrentUser();
                const userRole = activeUser ? activeUser.role : '';
                const hasGross = truck.gross_weight !== null && truck.gross_weight !== undefined && Number(truck.gross_weight) > 0;

                let weighActionBtn = '';
                if (userRole === 'weighment' && hasGross) {
                    weighActionBtn = `<span style="color:#10b981; font-weight:bold; font-size:0.85rem;">🔒 Gross Weight Saved</span>`;
                } else {
                    weighActionBtn = `<button class="btn btn-secondary btn-sm" onclick="window.triggerWeighmentEdit('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">${hasGross ? 'Update weight' : '⚖️ Record Weight'}</button>`;
                }

                tr.innerHTML = `
                    <td><strong>${truck.truck_id}</strong></td>
                    <td>${dateStr} ${timeStr}</td>
                    <td>${truck.company_name}</td>
                    <td><span style="font-family: monospace;">${truck.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${chNo}</span></td>
                    <td>${truck.gross_weight || '-'}</td>
                    <td>${truck.tare_weight || '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${truck.net_weight || '-'}</td>
                    <td style="text-align: center;">${photoHtml}</td>
                    <td>${weighActionBtn}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger);">Failed to load: ${e.message}</td></tr>`;
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    }

    // --- Unloading Bay Table ---
    const searchUnloadingInput = document.getElementById('search-unloading-input');
    if (searchUnloadingInput) {
        searchUnloadingInput.addEventListener('input', renderUnloadingLog);
    }

    async function renderUnloadingLog() {
        const tbody = document.getElementById('table-unloading-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">Loading unloading entries...</td></tr>';
        if (window.showGlobalLoader) window.showGlobalLoader('Fetching Unloading Clearances...');
        
        try {
            const trucks = await window.BiomassAPI.getTrucks();
            const filter = searchUnloadingInput ? searchUnloadingInput.value.toLowerCase().trim() : '';
            tbody.innerHTML = '';

            const filtered = trucks.filter(t => {
                const id = String(t.truck_id || '').toLowerCase();
                const comp = String(t.company_name || '').toLowerCase();
                const reg = String(t.truck_reg_number || '').toLowerCase();
                const ch = String(t.invoice_no || t.challan_no || '').toLowerCase();
                return id.includes(filter) || comp.includes(filter) || reg.includes(filter) || ch.includes(filter);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">No matching truck entries found.</td></tr>';
                return;
            }

            filtered.slice().reverse().forEach(truck => {
                const tr = document.createElement('tr');
                
                const dateStr = window.BiomassAPI.formatLocalYYYYMMDD(truck.entry_date);
                const timeStr = window.BiomassAPI.formatLocalTime(truck.entry_time);
                const chNo = truck.invoice_no || truck.challan_no || '-';

                let statusBadge = '';
                if (truck.acceptance_status === 'ACCEPTED') {
                    statusBadge = `<span class="badge badge-success" style="background:#10b981; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ ACCEPTED (${truck.moisture_pct !== null ? truck.moisture_pct + '%' : '<=14%'})</span>`;
                } else if (truck.acceptance_status === 'REJECTED') {
                    statusBadge = `<span class="badge badge-danger" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">⛔ REJECTED (${truck.moisture_pct !== null ? truck.moisture_pct + '%' : '>14%'})</span>`;
                    tr.style.background = 'rgba(239, 68, 68, 0.15)';
                } else {
                    statusBadge = `<span class="badge badge-warning" style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px;">⏳ Awaiting Lab Moisture</span>`;
                }

                const activeUser = window.BiomassAPI.getCurrentUser();
                const userRole = activeUser ? activeUser.role : '';

                let actionBtn = '';
                if (truck.acceptance_status === 'REJECTED') {
                    actionBtn = `<span style="color:#ef4444; font-weight:bold; font-size:0.85rem;">⛔ UNLOADING BLOCKED</span>`;
                } else if (truck.acceptance_status === 'ACCEPTED') {
                    const hasTare = truck.tare_weight !== null && truck.tare_weight !== undefined && truck.tare_weight !== '' && Number(truck.tare_weight) > 0;
                    if (hasTare) {
                        if (userRole === 'unloading') {
                            actionBtn = `<span style="color:#10b981; font-weight:bold; font-size:0.85rem;">🔒 Final Weight Saved</span>`;
                        } else {
                            actionBtn = `<button class="btn btn-secondary btn-sm" onclick="window.openUnloadingModal('${truck.truck_id}', ${truck.gross_weight}, ${truck.tare_weight})">✓ Update Weight</button>`;
                        }
                    } else {
                        actionBtn = `<button class="btn btn-primary btn-sm" onclick="window.openUnloadingModal('${truck.truck_id}', ${truck.gross_weight})">⚖️ Enter Final Weight</button>`;
                    }
                } else {
                    actionBtn = `<span style="color:#f59e0b; font-size:0.85rem;">⏳ Wait for Moisture Result</span>`;
                }

                tr.innerHTML = `
                    <td><strong>${truck.truck_id}</strong></td>
                    <td>${dateStr} ${timeStr}</td>
                    <td>${truck.company_name}</td>
                    <td><span style="font-family: monospace;">${truck.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${chNo}</span></td>
                    <td>${truck.gross_weight || '-'}</td>
                    <td>${statusBadge}</td>
                    <td>${truck.tare_weight || '-'}</td>
                    <td style="color: var(--primary); font-weight: bold;">${truck.net_weight || '-'}</td>
                    <td style="text-align: center;">${actionBtn}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger);">Failed to load unloading log: ${e.message}</td></tr>`;
        } finally {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
        }
    }

    window.openUnloadingModal = function(truckId, grossWeight, tareWeight) {
        const card = document.getElementById('unloading-result-card');
        const inputId = document.getElementById('unloading-weight-truck-id');
        const inputGross = document.getElementById('unloading-weight-gross');
        const inputTare = document.getElementById('unloading-weight-tare');
        const netDisplay = document.getElementById('unloading-weight-net');
        const banner = document.getElementById('unloading-status-banner');

        if (!card) return;
        inputId.value = truckId;
        inputGross.value = grossWeight || 0;
        inputTare.value = (tareWeight !== undefined && tareWeight !== null) ? tareWeight : '';
        
        const calcNet = (grossWeight || 0) - (Number(inputTare.value) || 0);
        netDisplay.textContent = `${calcNet > 0 ? calcNet : 0} kg`;

        if (banner) {
            banner.style.display = 'block';
            banner.className = 'alert alert-success';
            banner.textContent = `Cleared for unloading (Truck: ${truckId}). Enter Tare weight after unloading.`;
        }

        card.style.display = 'block';
        card.scrollIntoView({ behavior: 'smooth' });
    };

    window.viewPhoto = function(url, caption) {
        const lightbox = document.getElementById('lightbox');
        const img = document.getElementById('lightbox-img');
        const text = document.getElementById('lightbox-caption');

        img.src = url;
        text.textContent = caption;
        lightbox.style.display = 'flex';
    };

    window.triggerWeighmentEdit = async function(id, gross, tare) {
        const card = document.getElementById('weighment-edit-card');
        document.getElementById('weigh-edit-truck-id').value = id;
        document.getElementById('weigh-edit-title').textContent = `Update Weighment logs for [${id}]`;
        
        const grossInput = document.getElementById('weigh-edit-gross');
        const tareInput = document.getElementById('weigh-edit-tare');
        
        grossInput.value = gross || '';
        tareInput.value = tare || '';
        
        // Default: unlocked
        grossInput.disabled = false;
        tareInput.disabled = false;
        tareInput.placeholder = 'e.g. 11500';
        
        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;
        
        if (role === 'weighment') {
            // Lock Tare Weight (final weight) permanently for initial weighment operators
            tareInput.disabled = true;
            tareInput.value = '';
            tareInput.placeholder = 'Locked (Unloading Operator Only)';
        }
        
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
    let currentCompositeMatchingTrucks = [];

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

            // Fetch existing composite batches to cross-reference
            let existingBatches = [];
            try {
                const activeUser = window.BiomassAPI.getCurrentUser();
                if (window.BiomassAPI.isRemoteMode()) {
                    const rComp = await fetch(`${window.BiomassAPI.getAppsScriptUrl()}?action=getComposites&role=${activeUser.role}`);
                    const dComp = await rComp.json();
                    existingBatches = dComp.batches || [];
                } else {
                    existingBatches = window.BiomassAPI.getDB().composite_batches || [];
                }
            } catch(e) {}

            function isTruckAlreadyBatched(truck) {
                if (truck.composite_barcode_id) return true;
                return existingBatches.some(b => {
                    const g1 = String(b.daily_group_code || '').trim().toUpperCase();
                    const g2 = String(truck.daily_group_code || '').trim().toUpperCase();
                    const groupMatch = (g1 === g2 && g1 !== '');
                    const truckMatch = Array.isArray(b.parent_truck_ids) && b.parent_truck_ids.includes(truck.truck_id);
                    return groupMatch || truckMatch;
                });
            }

            // Filter trucks for company + date AND EXCLUDE REJECTED TRUCKS
            const matching = trucks.filter(t => {
                const normalizedEntryDate = window.BiomassAPI.formatLocalYYYYMMDD(t.entry_date);
                const isSupplierMatch = t.company_name === company && normalizedEntryDate === date;
                const isAccepted = t.acceptance_status !== 'REJECTED';
                return isSupplierMatch && isAccepted;
            });

            currentCompositeMatchingTrucks = matching;

            tbody.innerHTML = '';

            if (matching.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No accepted trucks found arriving from this supplier on the selected date.</td></tr>';
                return;
            }

            const allBatched = matching.every(t => isTruckAlreadyBatched(t));
            if (allBatched) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; background: #fffbeb; border: 1px solid #fef3c7; color: #b45309; padding: 1.25rem; font-weight: bold; border-radius: 6px;">⚠️ Note: All approved trucks arriving from this supplier today have already been mixed into a composite lot.<br><span style="font-weight: normal; font-size: 0.85rem; display: block; margin-top: 0.25rem;">You can lookup details inside Compiled Reports or the new Barcode Inspector tab.</span></td></tr>';
                return;
            }

            matching.forEach(truck => {
                const isBatched = isTruckAlreadyBatched(truck);

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
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger);">Failed to search: ${e.message}</td></tr>`;
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
            alert('Please select at least one accepted truck sample to mix.');
            return;
        }

        try {
            const parentTruck = currentCompositeMatchingTrucks.find(t => selectedIds.includes(t.truck_id));
            const groupCode = parentTruck ? parentTruck.daily_group_code : '';

            // Check if composite batch already exists
            let existingBatches = [];
            try {
                const activeUser = window.BiomassAPI.getCurrentUser();
                if (window.BiomassAPI.isRemoteMode()) {
                    const rComp = await fetch(`${window.BiomassAPI.getAppsScriptUrl()}?action=getComposites&role=${activeUser.role}`);
                    const dComp = await rComp.json();
                    existingBatches = dComp.batches || [];
                } else {
                    existingBatches = window.BiomassAPI.getDB().composite_batches || [];
                }
            } catch(e) {}

            const existingBatch = existingBatches.find(b => {
                const g1 = String(b.daily_group_code || '').trim().toUpperCase();
                const g2 = String(groupCode || '').trim().toUpperCase();
                return (g1 === g2 && g1 !== '');
            });

            if (existingBatch) {
                const userChoice = confirm(`NOTICE: Composite QR codes have ALREADY been generated for Mixing Group Code "${groupCode}".\n\nDo you want to re-display the existing QR codes to view, print, or download them again?`);
                if (!userChoice) return;

                // Render existing batch without creating new entry
                if (!existingBatch.lots) {
                    existingBatch.lots = {
                        test: existingBatch.test_lot || existingBatch.composite_barcode_id || `${existingBatch.composite_ref_id}-T`,
                        referee: existingBatch.referee_lot || `${existingBatch.composite_ref_id}-R`,
                        vendor: existingBatch.vendor_lot || `${existingBatch.composite_ref_id}-V`
                    };
                }

                const outputCard = document.getElementById('composite-output-card');
                outputCard.style.display = 'block';
                const groupLabel = `MIXING GROUP: ${existingBatch.daily_group_code || groupCode || 'N/A'}`;
                document.getElementById('comp-test-group-code').textContent = groupLabel;
                document.getElementById('comp-ref-group-code').textContent = groupLabel;
                document.getElementById('comp-vend-group-code').textContent = groupLabel;
                if (document.getElementById('comp-test-code')) document.getElementById('comp-test-code').style.display = 'none';
                if (document.getElementById('comp-ref-code')) document.getElementById('comp-ref-code').style.display = 'none';
                if (document.getElementById('comp-vend-code')) document.getElementById('comp-vend-code').style.display = 'none';

                const testEnc = await encryptPayload(existingBatch.lots.test);
                const refEnc = await encryptPayload(existingBatch.lots.referee);
                const vendEnc = await encryptPayload(existingBatch.lots.vendor);

                QRCode.toCanvas(document.getElementById('qr-canvas-comp-test'), testEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-ref'), refEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-vend'), vendEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                setupCompositePrintTriggers(existingBatch);
                return;
            }

            const res = await window.BiomassAPI.createCompositeBatch(company, date, selectedIds, selectedIds.length, selectedIds.length, groupCode);
            if (res.success) {
                const batch = res.batch;
                alert(`Composite batch created successfully for ${selectedIds.length} trucks!`);
                
                // Show output card
                const outputCard = document.getElementById('composite-output-card');
                outputCard.style.display = 'block';

                const groupLabel = `MIXING GROUP: ${batch.daily_group_code || groupCode || 'N/A'}`;
                document.getElementById('comp-test-group-code').textContent = groupLabel;
                document.getElementById('comp-ref-group-code').textContent = groupLabel;
                document.getElementById('comp-vend-group-code').textContent = groupLabel;
                if (document.getElementById('comp-test-code')) document.getElementById('comp-test-code').style.display = 'none';
                if (document.getElementById('comp-ref-code')) document.getElementById('comp-ref-code').style.display = 'none';
                if (document.getElementById('comp-vend-code')) document.getElementById('comp-vend-code').style.display = 'none';

                const testEnc = await encryptPayload(batch.lots.test);
                const refEnc = await encryptPayload(batch.lots.referee);
                const vendEnc = await encryptPayload(batch.lots.vendor);
                
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-test'), testEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-ref'), refEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                QRCode.toCanvas(document.getElementById('qr-canvas-comp-vend'), vendEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });

                setupCompositePrintTriggers(batch);
                
                // Reload list to mark as already batched
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
        
        const gCode = String(batch.daily_group_code || 'N/A').trim().toUpperCase();

        const setupPrint = async (lotId, sampleName) => {
            const encrypted = await encryptPayload(lotId);
            printContainer.innerHTML = `
                <div class="print-label-view" style="text-align: center; padding: 1rem; border: 2px solid #000; display: inline-block;">
                    <h2 style="font-size: 16pt; font-weight: bold; margin: 0 0 6px 0; font-family: monospace; color: #000;">MIXING GROUP: ${gCode}</h2>
                    <h3 style="font-size: 14pt; font-weight: bold; margin: 0 0 12px 0; color: #000; font-family: monospace;">SAMPLE: ${sampleName}</h3>
                    <div>
                        <canvas id="print-qr-target"></canvas>
                    </div>
                </div>
            `;
            QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                errorCorrectionLevel: 'H',
                width: 230,
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
            `Group_${gCode}_TEST_LOT`,
            `MIXING GROUP: ${gCode} | TEST LOT`,
            "TEST LOT"
        );
        document.getElementById('btn-download-comp-ref').onclick = () => downloadQrAsPng(
            '#qr-canvas-comp-ref', 
            `Group_${gCode}_REFEREE_LOT`,
            `MIXING GROUP: ${gCode} | REFEREE LOT`,
            "REFEREE LOT"
        );
        document.getElementById('btn-download-comp-vend').onclick = () => downloadQrAsPng(
            '#qr-canvas-comp-vend', 
            `Group_${gCode}_VENDOR_LOT`,
            `MIXING GROUP: ${gCode} | VENDOR LOT`,
            "VENDOR LOT"
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
            document.getElementById('summary-accept-reject').textContent = `${report.summary.accepted_count} / ${report.summary.rejected_count}`;
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

                let acceptanceBadge = '';
                if (row.acceptance_status === 'REJECTED') {
                    acceptanceBadge = `<span class="badge badge-danger" style="background:#ef4444; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">⛔ REJECTED</span><br><small style="color:#ef4444; font-size:0.75rem;">${row.rejection_reason || 'Moisture >14%'}</small>`;
                    tr.style.background = 'rgba(239, 68, 68, 0.12)';
                } else if (row.acceptance_status === 'ACCEPTED') {
                    acceptanceBadge = `<span class="badge badge-success" style="background:#10b981; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">✅ ACCEPTED</span>`;
                } else {
                    acceptanceBadge = `<span class="badge badge-warning" style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px;">⏳ Pending Lab 1</span>`;
                }

                const gcvText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : (row.gcv_value !== null ? row.gcv_value + ' kcal' : '<span class="badge badge-pending">Pending</span>');
                const ashText = row.acceptance_status === 'REJECTED' ? '<span style="color:#ef4444; font-weight:bold; font-size:0.75rem;">N/A (REJECTED)</span>' : (row.ash_pct !== null ? row.ash_pct + '%' : '<span class="badge badge-pending">Pending</span>');

                tr.innerHTML = `
                    <td><strong>${row.truck_id}</strong></td>
                    <td><span style="font-family: monospace;">${row.truck_reg_number}</span></td>
                    <td><span style="font-family: monospace;">${row.invoice_no || row.challan_no || '-'}</span></td>
                    <td style="font-weight: 500;">${row.moisture_pct !== null ? row.moisture_pct + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="font-weight: 500;">${row.fineness_value !== null ? row.fineness_value + '%' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td>${acceptanceBadge}</td>
                    <td><span class="badge badge-referee" style="font-weight: bold;">${row.mixing_group_code || 'N/A'}</span></td>
                    <td style="font-weight: 500;">${gcvText}</td>
                    <td style="font-weight: 500;">${ashText}</td>
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
                const acceptanceLabel = r.acceptance_status === 'REJECTED' 
                    ? `<span style="color:red; font-weight:bold;">⛔ REJECTED (${r.rejection_reason || 'Moisture >14%'})</span>` 
                    : r.acceptance_status === 'ACCEPTED' ? '<span style="color:green; font-weight:bold;">✅ ACCEPTED</span>' : 'Pending';
                const chNo = r.invoice_no || r.challan_no || '-';
                const gcvPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (r.gcv_value !== null ? r.gcv_value : 'Pending');
                const ashPrint = r.acceptance_status === 'REJECTED' ? 'N/A (REJECTED)' : (r.ash_pct !== null ? r.ash_pct + '%' : 'Pending');

                rowHtml += `
                    <tr>
                        <td><strong>${r.truck_id}</strong></td>
                        <td>${r.truck_reg_number}</td>
                        <td>${chNo}</td>
                        <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : 'Pending'}</td>
                        <td>${r.fineness_value !== null ? r.fineness_value + '%' : 'Pending'}</td>
                        <td>${acceptanceLabel}</td>
                        <td>${r.mixing_group_code || 'N/A'}</td>
                        <td>${gcvPrint}</td>
                        <td>${ashPrint}</td>
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
                                <th>Invoice / Challan No.</th>
                                <th>Moisture %</th>
                                <th>Fineness %</th>
                                <th>Acceptance</th>
                                <th>Mixing Group</th>
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
                            <div class="print-summary-lbl">Approved / Rejected</div>
                            <div class="print-summary-val" style="font-size: 11pt; padding-top: 4px;">${report.summary.accepted_count} / ${report.summary.rejected_count}</div>
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
        
        // QR labels no longer expire — they stay valid for the whole life of the consignment.
        return payload.id;
    }

    // ================= LAB 1 STATION 1 CONTROLLER (BLIND Moisture & Fineness) =================
    function getLab1FieldVisibility() {
        const user = window.BiomassAPI.getCurrentUser();
        const role = user ? user.role : null;
        // lab1m = Moisture-only login, lab1f = Fineness-only login, lab1/admin = both
        return {
            showMoisture: role !== 'lab1f',
            showFineness: role !== 'lab1m'
        };
    }

    function applyLab1RoleView() {
        const { showMoisture, showFineness } = getLab1FieldVisibility();

        const moistureGroup = document.getElementById('lab1-moisture-group');
        const finenessGroup = document.getElementById('lab1-fineness-group');
        const moistureInput = document.getElementById('lab1-moisture');
        const finenessInput = document.getElementById('lab1-fineness');

        moistureGroup.style.display = showMoisture ? '' : 'none';
        finenessGroup.style.display = showFineness ? '' : 'none';

        // A hidden required field blocks form submission, so toggle 'required' along with visibility
        moistureInput.required = showMoisture;
        finenessInput.required = showFineness;

        // Station title reflects which test this login is responsible for
        const titleEl = document.getElementById('lab1-station-title');
        if (showMoisture && showFineness) {
            titleEl.textContent = 'Lab Station 1 — Moisture & Fineness';
        } else if (showMoisture) {
            titleEl.textContent = 'Lab Station 1 — Moisture Testing';
        } else {
            titleEl.textContent = 'Lab Station 1 — Fineness Testing';
        }

        // Hide the corresponding column in the submissions history table
        const historyMoistureTh = document.getElementById('lab1-th-moisture');
        const historyFinenessTh = document.getElementById('lab1-th-fineness');
        if (historyMoistureTh) historyMoistureTh.style.display = showMoisture ? '' : 'none';
        if (historyFinenessTh) historyFinenessTh.style.display = showFineness ? '' : 'none';
    }

    function initLab1Screen() {
        document.getElementById('lab1-entry-card').style.display = 'none';
        document.getElementById('lab1-manual-input').value = '';
        applyLab1RoleView();
        renderLab1History();
        setupLab1CameraScanner();
        setupLab1FileUploadScanner();
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

                applyLab1RoleView();
                const { showMoisture, showFineness } = getLab1FieldVisibility();

                const moistureInput = document.getElementById('lab1-moisture');
                const finenessInput = document.getElementById('lab1-fineness');
                const form = document.getElementById('lab1-entry-form');
                const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

                const hasMoisture = data.moisture_pct !== null && 
                                    data.moisture_pct !== undefined && 
                                    data.moisture_pct !== '' && 
                                    Number(data.moisture_pct) > 0;

                const hasFineness = data.fineness_value !== null && 
                                    data.fineness_value !== undefined && 
                                    data.fineness_value !== '' && 
                                    Number(data.fineness_value) > 0;

                moistureInput.value = hasMoisture ? data.moisture_pct : '';
                finenessInput.value = hasFineness ? data.fineness_value : '';

                const activeUser = window.BiomassAPI.getCurrentUser();
                const userRole = activeUser ? activeUser.role : '';

                let isLockedForRole = false;
                if (userRole === 'lab1m') {
                    // Moisture tester: only locked if moisture is already entered
                    moistureInput.disabled = hasMoisture;
                    finenessInput.disabled = true;
                    isLockedForRole = hasMoisture;
                } else if (userRole === 'lab1f') {
                    // Fineness tester: only locked if fineness is already entered
                    moistureInput.disabled = true;
                    finenessInput.disabled = hasFineness;
                    isLockedForRole = hasFineness;
                } else {
                    // Combined Lab1 or Admin
                    moistureInput.disabled = hasMoisture;
                    finenessInput.disabled = hasFineness;
                    isLockedForRole = hasMoisture && hasFineness;
                }

                if (isLockedForRole) {
                    if (submitBtn) submitBtn.disabled = true;
                    alertBox.textContent = `Notice: This testing portion has already been submitted and locked for your role at ${data.tested_at || 'earlier'}. No further edits allowed.`;
                    alertBox.className = 'alert alert-warning';
                    alertBox.style.display = 'flex';
                } else {
                    if (submitBtn) submitBtn.disabled = false;
                    alertBox.style.display = 'none';
                }

                // Focus whichever field this login is actually responsible for
                if (showMoisture) {
                    moistureInput.focus();
                } else if (showFineness) {
                    finenessInput.focus();
                }
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
        
        const { showMoisture, showFineness } = getLab1FieldVisibility();
        const barcode = document.getElementById('lab1-barcode-id').value;
        const moisture = showMoisture ? document.getElementById('lab1-moisture').value : '';
        const fineness = showFineness ? document.getElementById('lab1-fineness').value : '';

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
        const { showMoisture, showFineness } = getLab1FieldVisibility();
        const colCount = 2 + (showMoisture ? 1 : 0) + (showFineness ? 1 : 0);
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center;">Loading history...</td></tr>`;

        try {
            const history = await window.BiomassAPI.getLab1History();
            tbody.innerHTML = '';
            
            if (history.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center;">No tests submitted by your account today.</td></tr>`;
                return;
            }

            history.slice().reverse().forEach((row, idx) => {
                const tr = document.createElement('tr');
                const moistureCell = showMoisture ? `<td>${row.moisture_pct}%</td>` : '';
                const finenessCell = showFineness ? `<td>${row.fineness_value}%</td>` : '';
                tr.innerHTML = `
                    <td><strong style="font-family: monospace;">Sample #${history.length - idx}</strong></td>
                    ${moistureCell}
                    ${finenessCell}
                    <td>${row.tested_at.split(' ')[1] || row.tested_at}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch(e) {
            tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align: center; color: var(--danger);">Failed to load history: ${e.message}</td></tr>`;
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
                const searchCode = String(groupCode || '').trim().toUpperCase();

                const groupTrucks = trucks.filter(t => String(t.daily_group_code || '').trim().toUpperCase() === searchCode);
                
                if (groupTrucks.length === 0) {
                    alert(`No trucks found registered under Group Code: "${groupCode}".`);
                    btnGen.disabled = false;
                    btnGen.textContent = 'Generate';
                    return;
                }

                const acceptedTrucks = groupTrucks.filter(t => t.acceptance_status !== 'REJECTED');
                if (acceptedTrucks.length === 0) {
                    alert(`Cannot create composite sample: All ${groupTrucks.length} truck(s) under Group Code [${groupCode}] were REJECTED in Lab-1 moisture testing.`);
                    btnGen.disabled = false;
                    btnGen.textContent = 'Generate';
                    return;
                }

                // Question 1: Blind prompt asking how many physical samples were mixed in the lab (No system count revealed)
                const physicalCountStr = prompt(`How many physical samples for Group Code "${groupCode}" were mixed together in the laboratory?`);
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
                
                // Question 2: Check mismatch against acceptedTrucks.length
                if (physicalCount !== acceptedTrucks.length) {
                    const confirmMismatch = confirm(`WARNING: Mismatch detected!\n- System accepted count: ${acceptedTrucks.length} sample(s)\n- Laboratory mixed count: ${physicalCount} sample(s)\n\nAre you sure you want to compile these composite barcodes anyway?`);
                    if (!confirmMismatch) {
                        btnGen.disabled = false;
                        btnGen.textContent = 'Generate';
                        return;
                    }
                }
                
                const res = await window.BiomassAPI.generateCompositeFromGroup(groupCode, physicalCount);
                if (res.success) {
                    if (res.already_exists) {
                        const rePrint = confirm(`NOTICE: Composite QR codes have ALREADY been generated for Mixing Group Code "${groupCode}".\n\nDo you want to re-display the existing QR codes to view, print, or download them again?`);
                        if (!rePrint) {
                            btnGen.disabled = false;
                            btnGen.textContent = 'Generate Barcodes';
                            return;
                        }
                    }

                    const batch = res.batch;
                    if (!batch.lots) {
                        batch.lots = {
                            test: batch.test_lot || batch.composite_barcode_id || `${batch.composite_ref_id}-T`,
                            referee: batch.referee_lot || `${batch.composite_ref_id}-R`,
                            vendor: batch.vendor_lot || `${batch.composite_ref_id}-V`
                        };
                    }

                    outputDiv.style.display = 'block';
                    
                    const gCodeLab2Text = String(batch.daily_group_code || groupCode || 'N/A').trim().toUpperCase();
                    const groupLabelText = `MIXING GROUP: ${gCodeLab2Text}`;

                    if (document.getElementById('lab2-test-group-code')) document.getElementById('lab2-test-group-code').textContent = groupLabelText;
                    if (document.getElementById('lab2-test-code')) document.getElementById('lab2-test-code').style.display = 'none';

                    if (document.getElementById('lab2-ref-group-code')) document.getElementById('lab2-ref-group-code').textContent = groupLabelText;
                    if (document.getElementById('lab2-ref-code')) document.getElementById('lab2-ref-code').style.display = 'none';

                    if (document.getElementById('lab2-vend-group-code')) document.getElementById('lab2-vend-group-code').textContent = groupLabelText;
                    if (document.getElementById('lab2-vend-code')) document.getElementById('lab2-vend-code').style.display = 'none';

                    // Render QR codes
                    const testEnc = await encryptPayload(batch.lots.test);
                    const refEnc = await encryptPayload(batch.lots.referee);
                    const vendEnc = await encryptPayload(batch.lots.vendor);

                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-test'), testEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-ref'), refEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });
                    QRCode.toCanvas(document.getElementById('qr-canvas-lab2-vend'), vendEnc, { errorCorrectionLevel: 'H', width: 140, margin: 2 });

                    if (!res.already_exists) {
                        alert(`Composite QR codes compiled successfully for Group [${groupCode}]!`);
                    }
                    
                    const gCodeLab2 = String(batch.daily_group_code || groupCode || 'N/A').trim().toUpperCase();

                    const printContainer = document.getElementById('print-section');
                    const setupPrint = async (lotId, sampleName) => {
                        const encrypted = await encryptPayload(lotId);
                        printContainer.innerHTML = `
                            <div class="print-label-view" style="text-align: center; padding: 1rem; border: 2px solid #000; display: inline-block;">
                                <h2 style="font-size: 16pt; font-weight: bold; margin: 0 0 6px 0; font-family: monospace; color: #000;">MIXING GROUP: ${gCodeLab2}</h2>
                                <h3 style="font-size: 14pt; font-weight: bold; margin: 0 0 12px 0; color: #000; font-family: monospace;">SAMPLE: ${sampleName}</h3>
                                <div>
                                    <canvas id="print-qr-target"></canvas>
                                </div>
                            </div>
                        `;
                        QRCode.toCanvas(document.getElementById('print-qr-target'), encrypted, {
                            errorCorrectionLevel: 'H',
                            width: 230,
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
                        `Group_${gCodeLab2}_TEST_LOT`,
                        `MIXING GROUP: ${gCodeLab2} | TEST LOT`,
                        "TEST LOT"
                    );
                    document.getElementById('btn-download-lab2-ref').onclick = () => downloadQrAsPng(
                        '#qr-canvas-lab2-ref', 
                        `Group_${gCodeLab2}_REFEREE_LOT`,
                        `MIXING GROUP: ${gCodeLab2} | REFEREE LOT`,
                        "REFEREE LOT"
                    );
                    document.getElementById('btn-download-lab2-vend').onclick = () => downloadQrAsPng(
                        '#qr-canvas-lab2-vend', 
                        `Group_${gCodeLab2}_VENDOR_LOT`,
                        `MIXING GROUP: ${gCodeLab2} | VENDOR LOT`,
                        "VENDOR LOT"
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
    function initAdminInspectorTab() {
        document.getElementById('inspector-result-card').style.display = 'none';
        document.getElementById('inspector-manual-input').value = '';
        setupInspectorCameraScanner();
        setupInspectorFileUploadScanner();
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
                            <strong>Test Lot Barcode ID:</strong> ${res.batch.test_lot || res.batch.composite_barcode_id || (res.batch.lots ? res.batch.lots.test : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-T' : 'N/A')}<br>
                            <strong>Referee Lot Barcode ID:</strong> ${res.batch.referee_lot || (res.batch.lots ? res.batch.lots.referee : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-R' : 'N/A')}<br>
                            <strong>Vendor Lot Barcode ID:</strong> ${res.batch.vendor_lot || (res.batch.lots ? res.batch.lots.vendor : '') || (res.batch.composite_ref_id ? res.batch.composite_ref_id + '-V' : 'N/A')}<br>
                            <strong>System Intake Samples Count:</strong> ${res.matching_trucks && res.matching_trucks.length > 0 ? res.matching_trucks.length : (Number(res.batch.system_samples_count) || 1)}<br>
                            <strong>Lab Confirmed Mixed Count:</strong> <strong style="color: var(--primary);">${res.matching_trucks && res.matching_trucks.length > 0 ? res.matching_trucks.length : (Number(res.batch.mixed_samples_count) || 1)}</strong><br><br>
                            
                            <strong>Mixed Intake Trucks:</strong><br>
                            ${trucksHtml || 'None'}
                        </div>
                        ${lab2ResultsHtml}
                    `;
                }
            } else {
                alert('Inspection failed: ' + res.message);
            }
        } catch (err) {
            alert('Lookup error: ' + err.message);
        }
    }

    // =========================================================================
    // TOP-MANAGEMENT EXECUTIVE DASHBOARD (NO ASH CONTENT, NO FINENESS)
    // =========================================================================
    let execChartInstances = {};

    async function initExecutiveDashboard() {
        const periodSelect = document.getElementById('exec-filter-period');
        const customDateContainer = document.getElementById('exec-custom-date-container');
        const startDateInput = document.getElementById('exec-filter-start-date');
        const endDateInput = document.getElementById('exec-filter-end-date');
        const companySelect = document.getElementById('exec-filter-company');
        const statusSelect = document.getElementById('exec-filter-status');
        const searchInput = document.getElementById('exec-filter-search');
        const refreshBtn = document.getElementById('exec-btn-refresh');
        const exportCsvBtn = document.getElementById('exec-btn-export-csv');
        const exportPdfBtn = document.getElementById('exec-btn-export-pdf');
        const themeToggleBtn = document.getElementById('exec-btn-theme-toggle');

        if (!periodSelect) return;

        // Toggle custom date container
        periodSelect.onchange = () => {
            if (periodSelect.value === 'custom') {
                if (customDateContainer) customDateContainer.style.display = 'block';
            } else {
                if (customDateContainer) customDateContainer.style.display = 'none';
            }
            renderExecutiveDashboardData();
        };

        if (startDateInput) startDateInput.onchange = renderExecutiveDashboardData;
        if (endDateInput) endDateInput.onchange = renderExecutiveDashboardData;
        if (companySelect) companySelect.onchange = renderExecutiveDashboardData;
        if (statusSelect) statusSelect.onchange = renderExecutiveDashboardData;
        if (searchInput) searchInput.oninput = renderExecutiveDashboardData;

        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '⏳ Syncing...';
                await renderExecutiveDashboardData(true);
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 Refresh Live Data';
            };
        }

        if (themeToggleBtn) {
            themeToggleBtn.onclick = () => {
                document.body.classList.toggle('light-theme');
                const isLight = document.body.classList.contains('light-theme');
                themeToggleBtn.textContent = isLight ? '🌙 Dark Mode' : '☀️ Light Mode';
                renderExecutiveDashboardData();
            };
        }

        if (exportCsvBtn) {
            exportCsvBtn.onclick = () => exportExecutiveCsv();
        }

        if (exportPdfBtn) {
            exportPdfBtn.onclick = () => window.print();
        }

        // Initial render
        await renderExecutiveDashboardData();
    }

    async function renderExecutiveDashboardData(forceFetch = false) {
        try {
            if (window.showGlobalLoader) window.showGlobalLoader('Loading Executive Management Dashboard...');

            // Fetch data from API
            const dashData = window.BiomassAPI.getAllDashboardData ? await window.BiomassAPI.getAllDashboardData() : { trucks: await window.BiomassAPI.getTrucks(), lab1: [], composites: [] };
            const trucks = dashData.trucks || [];
            const lab1Results = dashData.lab1 || [];
            const composites = dashData.composites || [];

            // Populate Company Dropdown if empty
            const companySelect = document.getElementById('exec-filter-company');
            if (companySelect && companySelect.options.length <= 1) {
                const companies = Array.from(new Set(trucks.map(t => t.company_name).filter(Boolean))).sort();
                companies.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c;
                    companySelect.appendChild(opt);
                });
            }

            // Create truck lookup map for Lab 1 & Composite Lab 2 results
            const lab1Map = {};
            if (Array.isArray(lab1Results)) {
                lab1Results.forEach(r => {
                    if (r.sample1_barcode_id) lab1Map[r.sample1_barcode_id] = r;
                });
            }

            const compMap = {};
            if (Array.isArray(composites)) {
                composites.forEach(c => {
                    let pIds = [];
                    if (Array.isArray(c.parent_truck_ids)) pIds = c.parent_truck_ids;
                    else if (typeof c.parent_truck_ids === 'string') {
                        try { pIds = JSON.parse(c.parent_truck_ids); } catch(e) {}
                    }
                    pIds.forEach(id => {
                        compMap[id] = c;
                    });
                });
            }

            // Combine truck records
            const records = trucks.map(t => {
                const l1 = lab1Map[t.sample1_barcode_id] || {};
                const c2 = compMap[t.truck_id] || {};
                const moisture = l1.moisture_pct !== undefined && l1.moisture_pct !== null && l1.moisture_pct !== "" ? Number(l1.moisture_pct) : (t.moisture_pct !== undefined && t.moisture_pct !== null ? Number(t.moisture_pct) : null);
                const gcv = c2.gcv_value !== undefined && c2.gcv_value !== null && c2.gcv_value !== "" ? Number(c2.gcv_value) : null;
                const status = t.acceptance_status || (moisture !== null ? (moisture <= 14.0 ? 'ACCEPTED' : 'REJECTED') : 'PENDING');
                
                let stage = 'Gate Registered';
                if (status === 'REJECTED') stage = 'Rejected (Moisture Breach)';
                else if (c2.gcv_value) stage = 'Completed & Audited';
                else if (t.gross_weight && t.tare_weight) stage = 'Unloaded & Weighted';
                else if (moisture !== null) stage = 'Lab Moisture Tested';

                const netKg = Number(t.net_weight) || (Number(t.gross_weight) && Number(t.tare_weight) ? Math.max(0, Number(t.gross_weight) - Number(t.tare_weight)) : 0);
                const netMT = netKg / 1000.0;

                let rawDateStr = t.entry_date || t.date || t.timestamp || t.created_at;
                let parsedDate = rawDateStr ? new Date(rawDateStr) : new Date();
                if (isNaN(parsedDate.getTime())) parsedDate = new Date();

                return {
                    ...t,
                    moisture_pct: moisture,
                    gcv_value: gcv,
                    acceptance_status: status,
                    pipeline_stage: stage,
                    net_weight_kg: netKg,
                    net_weight_mt: netMT,
                    date_obj: parsedDate
                };
            });

            // Calculate Live Operational Pipeline Counts (Unfiltered)
            const gateEl = document.getElementById('pipe-gate-count');
            const lab1El = document.getElementById('pipe-lab1-count');
            const weighEl = document.getElementById('pipe-weigh-count');
            const lab2El = document.getElementById('pipe-lab2-count');
            const compEl = document.getElementById('pipe-completed-count');

            if (gateEl) gateEl.textContent = records.filter(r => r.pipeline_stage === 'Gate Registered').length;
            if (lab1El) lab1El.textContent = records.filter(r => r.pipeline_stage === 'Lab Moisture Tested').length;
            if (weighEl) weighEl.textContent = records.filter(r => r.pipeline_stage === 'Unloaded & Weighted').length;
            if (lab2El) lab2El.textContent = records.filter(r => r.gcv_value === null && r.pipeline_stage === 'Unloaded & Weighted').length;
            if (compEl) compEl.textContent = records.filter(r => r.pipeline_stage === 'Completed & Audited').length;

            // Apply Filters (Date Range, Supplier, Status, Search)
            const period = document.getElementById('exec-filter-period')?.value || 'all';
            const compFilter = document.getElementById('exec-filter-company')?.value || 'ALL';
            const statusFilter = document.getElementById('exec-filter-status')?.value || 'ALL';
            const searchQuery = document.getElementById('exec-filter-search')?.value.toLowerCase().trim() || '';

            const now = new Date();
            let startBoundary = null;
            let endBoundary = null;

            if (period === 'today') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            } else if (period === 'yesterday') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
                endBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            } else if (period === 'last7') {
                startBoundary = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            } else if (period === 'this_month') {
                startBoundary = new Date(now.getFullYear(), now.getMonth(), 1);
            } else if (period === 'this_year') {
                startBoundary = new Date(now.getFullYear(), 0, 1);
            } else if (period === 'custom') {
                const sVal = document.getElementById('exec-filter-start-date')?.value;
                const eVal = document.getElementById('exec-filter-end-date')?.value;
                if (sVal) startBoundary = new Date(sVal + 'T00:00:00');
                if (eVal) endBoundary = new Date(eVal + 'T23:59:59');
            }

            const filteredRecords = records.filter(r => {
                if (startBoundary && r.date_obj < startBoundary) return false;
                if (endBoundary && r.date_obj > endBoundary) return false;
                if (compFilter !== 'ALL' && r.company_name !== compFilter) return false;
                if (statusFilter !== 'ALL' && r.acceptance_status !== statusFilter) return false;
                if (searchQuery) {
                    const matchText = `${r.truck_id} ${r.truck_reg_number} ${r.company_name} ${r.driver_name} ${r.invoice_no}`.toLowerCase();
                    if (!matchText.includes(searchQuery)) return false;
                }
                return true;
            });

            // Update Summary KPI Cards
            const totalCount = filteredRecords.length;
            const acceptedList = filteredRecords.filter(r => r.acceptance_status === 'ACCEPTED');
            const rejectedList = filteredRecords.filter(r => r.acceptance_status === 'REJECTED');
            
            const totalNetMT = acceptedList.reduce((sum, r) => sum + r.net_weight_mt, 0);
            const acceptRate = totalCount > 0 ? ((acceptedList.length / totalCount) * 100).toFixed(1) : '0.0';
            const rejectRate = totalCount > 0 ? ((rejectedList.length / totalCount) * 100).toFixed(1) : '0.0';

            const moistureVals = acceptedList.map(r => r.moisture_pct).filter(v => v !== null && !isNaN(v));
            const avgMoisture = moistureVals.length > 0 ? (moistureVals.reduce((a, b) => a + b, 0) / moistureVals.length).toFixed(2) : '0.00';

            const gcvVals = filteredRecords.map(r => r.gcv_value).filter(v => v !== null && !isNaN(v));
            const avgGCV = gcvVals.length > 0 ? Math.round(gcvVals.reduce((a, b) => a + b, 0) / gcvVals.length) : '0';

            const kpiNetEl = document.getElementById('kpi-net-weight-mt');
            const kpiTotEl = document.getElementById('kpi-total-trucks');
            const kpiBreakEl = document.getElementById('kpi-trucks-breakdown');
            const kpiAccEl = document.getElementById('kpi-acceptance-rate');
            const kpiRejEl = document.getElementById('kpi-rejection-rate');
            const kpiMoisEl = document.getElementById('kpi-avg-moisture');
            const kpiGcvEl = document.getElementById('kpi-avg-gcv');

            if (kpiNetEl) kpiNetEl.textContent = `${totalNetMT.toFixed(2)} MT`;
            if (kpiTotEl) kpiTotEl.textContent = totalCount;
            if (kpiBreakEl) kpiBreakEl.textContent = `${acceptedList.length} Accepted | ${rejectedList.length} Rejected`;
            if (kpiAccEl) kpiAccEl.textContent = `${acceptRate}%`;
            if (kpiRejEl) kpiRejEl.textContent = `Rejection Rate: ${rejectRate}%`;
            if (kpiMoisEl) kpiMoisEl.textContent = `${avgMoisture}%`;
            if (kpiGcvEl) kpiGcvEl.textContent = `${avgGCV} kcal/kg`;

            // Render Charts
            renderExecutiveCharts(filteredRecords);

            // Render Supplier Performance Table
            renderSupplierIntelligenceTable(filteredRecords);

            // Render Consignments Audit Table
            renderConsignmentsAuditTable(filteredRecords);

            if (window.hideGlobalLoader) window.hideGlobalLoader();
        } catch (err) {
            if (window.hideGlobalLoader) window.hideGlobalLoader();
            console.error('Failed to render executive dashboard:', err);
        }
    }

    function renderExecutiveCharts(records) {
        if (typeof window.Chart === 'undefined') return;

        const isLight = document.body.classList.contains('light-theme');
        const textColor = isLight ? '#374151' : '#9ca3af';
        const gridColor = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';

        const chartPlugins = {
            legend: { labels: { color: textColor, font: { family: 'sans-serif', size: 11, weight: 'bold' } } },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                titleColor: '#ffffff',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(16, 185, 129, 0.3)',
                borderWidth: 1,
                padding: 10,
                boxPadding: 4,
                usePointStyle: true
            }
        };

        // Group records by date (YYYY-MM-DD)
        const dateGroups = {};
        records.forEach(r => {
            const dateStr = r.date_obj ? r.date_obj.toISOString().substring(0, 10) : '2026-08-01';
            if (!dateGroups[dateStr]) {
                dateGroups[dateStr] = { date: dateStr, count: 0, accepted: 0, rejected: 0, netMT: 0, moistureList: [], gcvList: [] };
            }
            dateGroups[dateStr].count++;
            if (r.acceptance_status === 'ACCEPTED') {
                dateGroups[dateStr].accepted++;
                dateGroups[dateStr].netMT += r.net_weight_mt;
            } else if (r.acceptance_status === 'REJECTED') {
                dateGroups[dateStr].rejected++;
            }
            if (r.moisture_pct !== null) dateGroups[dateStr].moistureList.push(r.moisture_pct);
            if (r.gcv_value !== null) dateGroups[dateStr].gcvList.push(r.gcv_value);
        });

        const sortedDates = Object.keys(dateGroups).sort();
        const labels = sortedDates.length > 0 ? sortedDates : ['No Data'];
        const tonnageData = sortedDates.map(d => Number(dateGroups[d].netMT.toFixed(2)));
        const truckCountData = sortedDates.map(d => dateGroups[d].count);
        const acceptedData = sortedDates.map(d => dateGroups[d].accepted);
        const rejectedData = sortedDates.map(d => dateGroups[d].rejected);
        const avgMoistureData = sortedDates.map(d => {
            const arr = dateGroups[d].moistureList;
            return arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
        });
        const avgGcvData = sortedDates.map(d => {
            const arr = dateGroups[d].gcvList;
            return arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        });

        // 1. Chart: Tonnage & Consignment Trend
        createOrUpdateChart('chart-tonnage-trend', {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Procured Net Tonnage (MT)', data: tonnageData, backgroundColor: 'rgba(16, 185, 129, 0.75)', borderColor: '#10b981', borderWidth: 1, borderRadius: 6, yAxisID: 'y' },
                    { label: 'Truck Count', data: truckCountData, type: 'line', borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 3, pointRadius: 4, tension: 0.3, yAxisID: 'y1' }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { type: 'linear', position: 'left', title: { display: true, text: 'Net Tonnage (MT)', color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } },
                    y1: { type: 'linear', position: 'right', title: { display: true, text: 'Truck Count', color: textColor }, ticks: { color: textColor }, grid: { drawOnChartArea: false } }
                }
            }
        });

        // 2. Chart: Acceptance vs Rejection Trend
        createOrUpdateChart('chart-acceptance-trend', {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Accepted', data: acceptedData, backgroundColor: '#10b981', borderRadius: 6 },
                    { label: 'Rejected', data: rejectedData, backgroundColor: '#ef4444', borderRadius: 6 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { stacked: true, ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { stacked: true, ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });

        // 3. Chart: GCV Trend
        createOrUpdateChart('chart-gcv-trend', {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Avg GCV (kcal/kg)', data: avgGcvData, borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.2)', fill: true, tension: 0.35, pointRadius: 5, pointBackgroundColor: '#a855f7'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor }, title: { display: true, text: 'kcal/kg', color: textColor } }
                }
            }
        });

        // 4. Chart: Moisture Trend vs 14% Limit
        createOrUpdateChart('chart-moisture-trend', {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Avg Moisture %', data: avgMoistureData, borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.2)', fill: true, tension: 0.35, pointRadius: 5, pointBackgroundColor: '#f59e0b' },
                    { label: 'Max Limit (14.0%)', data: labels.map(() => 14.0), borderColor: '#ef4444', borderDash: [6, 6], pointRadius: 0, borderWidth: 2 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor }, title: { display: true, text: 'Moisture %', color: textColor } }
                }
            }
        });

        // 5. Chart: Top 10 Suppliers by Tonnage
        const compMap = {};
        records.forEach(r => {
            if (r.company_name) {
                if (!compMap[r.company_name]) compMap[r.company_name] = 0;
                if (r.acceptance_status === 'ACCEPTED') compMap[r.company_name] += r.net_weight_mt;
            }
        });
        const sortedSuppliers = Object.keys(compMap).sort((a, b) => compMap[b] - compMap[a]).slice(0, 10);
        const supplierTonnage = sortedSuppliers.map(s => Number(compMap[s].toFixed(2)));

        createOrUpdateChart('chart-supplier-tonnage', {
            type: 'bar',
            data: {
                labels: sortedSuppliers.length > 0 ? sortedSuppliers : ['No Data'],
                datasets: [{ label: 'Net Biomass (MT)', data: supplierTonnage, backgroundColor: 'rgba(59, 130, 246, 0.85)', borderRadius: 6 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });

        // 6. Chart: Scatter Moisture vs GCV
        const scatterPoints = records.filter(r => r.moisture_pct !== null && r.gcv_value !== null).map(r => ({ x: r.moisture_pct, y: r.gcv_value }));

        createOrUpdateChart('chart-moisture-gcv-scatter', {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'Consignment Sample (Moisture vs GCV)', data: scatterPoints, backgroundColor: 'rgba(16, 185, 129, 0.85)', pointRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: chartPlugins,
                scales: {
                    x: { title: { display: true, text: 'Moisture %', color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } },
                    y: { title: { display: true, text: 'GCV (kcal/kg)', color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }

    function createOrUpdateChart(canvasId, config) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        if (execChartInstances[canvasId]) {
            execChartInstances[canvasId].destroy();
        }
        execChartInstances[canvasId] = new window.Chart(ctx, config);
    }

    function renderSupplierIntelligenceTable(records) {
        const tbody = document.getElementById('exec-supplier-table-body');
        if (!tbody) return;

        const groups = {};
        records.forEach(r => {
            const name = r.company_name || 'Unknown Supplier';
            if (!groups[name]) {
                groups[name] = { name, total: 0, accepted: 0, rejected: 0, netMT: 0, moistureList: [], gcvList: [] };
            }
            groups[name].total++;
            if (r.acceptance_status === 'ACCEPTED') {
                groups[name].accepted++;
                groups[name].netMT += r.net_weight_mt;
            } else if (r.acceptance_status === 'REJECTED') {
                groups[name].rejected++;
            }
            if (r.moisture_pct !== null) groups[name].moistureList.push(r.moisture_pct);
            if (r.gcv_value !== null) groups[name].gcvList.push(r.gcv_value);
        });

        const list = Object.values(groups).sort((a, b) => b.total - a.total);

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No supplier records match filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(g => {
            const acceptPct = ((g.accepted / g.total) * 100).toFixed(1);
            const rejectPct = ((g.rejected / g.total) * 100).toFixed(1);
            const avgM = g.moistureList.length > 0 ? (g.moistureList.reduce((a, b) => a + b, 0) / g.moistureList.length).toFixed(2) + '%' : '-';
            const avgG = g.gcvList.length > 0 ? Math.round(g.gcvList.reduce((a, b) => a + b, 0) / g.gcvList.length) + ' kcal/kg' : '-';

            return `
                <tr>
                    <td><strong>${g.name}</strong></td>
                    <td>${g.total}</td>
                    <td><span class="badge badge-complete">${g.accepted}</span></td>
                    <td><span class="badge badge-rejected">${g.rejected}</span></td>
                    <td><strong style="color: #10b981;">${acceptPct}%</strong></td>
                    <td><strong style="color: #ef4444;">${rejectPct}%</strong></td>
                    <td>${avgM}</td>
                    <td>${avgG}</td>
                    <td><strong>${g.netMT.toFixed(2)} MT</strong></td>
                </tr>
            `;
        }).join('');
    }

    function renderConsignmentsAuditTable(records) {
        const tbody = document.getElementById('exec-consignments-table-body');
        const countInfo = document.getElementById('exec-table-count-info');
        if (!tbody) return;

        if (countInfo) countInfo.textContent = `Showing ${records.length} consignments`;

        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No consignments match current filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = records.slice(0, 50).map(r => {
            const dateStr = r.date_obj ? r.date_obj.toISOString().substring(0, 10) : (r.date || '-');
            const statusBadge = r.acceptance_status === 'ACCEPTED' ? 
                '<span class="badge badge-complete">ACCEPTED</span>' : 
                (r.acceptance_status === 'REJECTED' ? '<span class="badge badge-rejected">REJECTED</span>' : '<span class="badge badge-pending">PENDING</span>');

            return `
                <tr>
                    <td>${dateStr}</td>
                    <td>${r.invoice_no || r.challan_no || '-'}</td>
                    <td><strong>${r.company_name || '-'}</strong></td>
                    <td>${r.truck_reg_number || r.truck_id || '-'}</td>
                    <td>${r.driver_name || '-'}</td>
                    <td>${r.gross_weight ? r.gross_weight + ' kg' : '-'}</td>
                    <td>${r.tare_weight ? r.tare_weight + ' kg' : '-'}</td>
                    <td><strong>${r.net_weight_mt > 0 ? r.net_weight_mt.toFixed(2) + ' MT' : '-'}</strong></td>
                    <td>${r.moisture_pct !== null ? r.moisture_pct + '%' : '-'}</td>
                    <td>${r.gcv_value ? r.gcv_value + ' kcal/kg' : '-'}</td>
                    <td>${statusBadge}</td>
                    <td><span class="badge badge-info">${r.pipeline_stage}</span></td>
                </tr>
            `;
        }).join('');
    }

    function exportExecutiveCsv() {
        renderExecutiveDashboardData().then(() => {
            const rows = [];
            rows.push(['Date', 'Challan/Invoice', 'Supplier', 'Truck Registration', 'Driver', 'Gross Wt (kg)', 'Tare Wt (kg)', 'Net Wt (MT)', 'Moisture %', 'GCV (kcal/kg)', 'Status', 'Stage']);
            
            const trs = document.querySelectorAll('#exec-consignments-table-body tr');
            trs.forEach(tr => {
                const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.replace(/,/g, ' '));
                if (tds.length >= 12) rows.push(tds);
            });

            const csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `Executive_Biomass_Report_${new Date().toISOString().substring(0, 10)}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    // Initialize Executive Dashboard when Admin switches to admin-dashboard tab
    const dashTabBtn = document.getElementById('tab-btn-dashboard');
    if (dashTabBtn) {
        dashTabBtn.addEventListener('click', () => {
            initExecutiveDashboard();
        });
    }

    // ================= CORE RUNNER ON LOAD =================
    routeSession();
    if (sessionStorage.getItem('auth_role') === 'admin') {
        initExecutiveDashboard();
    }
});
