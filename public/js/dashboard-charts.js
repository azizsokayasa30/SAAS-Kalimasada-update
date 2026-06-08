            // ========== NAS MONITORING DASHBOARD ==========
            let monitoringInterval = null;
            let selectedNAS1 = null;
            let selectedNAS2 = null;
            
            let allRouters = [];
            
            // Load routers list
            async function loadRouters() {
                try {
                    const res = await fetch('/api/dashboard/routers');
                    const data = await res.json();
                    if (data.success && data.routers) {
                        allRouters = data.routers;
                        
                        const select1 = document.getElementById('nasSelect1');
                        const select2 = document.getElementById('nasSelect2');
                        
                        // Clear existing options (except first)
                        while (select1.children.length > 1) select1.removeChild(select1.lastChild);
                        while (select2.children.length > 1) select2.removeChild(select2.lastChild);
                        
                        data.routers.forEach(router => {
                            const opt1 = document.createElement('option');
                            opt1.value = router.id;
                            opt1.textContent = `${router.name} (${router.nas_ip})`;
                            select1.appendChild(opt1);
                            
                            const opt2 = document.createElement('option');
                            opt2.value = router.id;
                            opt2.textContent = `${router.name} (${router.nas_ip})`;
                            select2.appendChild(opt2);
                        });
                        
                        // Selector statis: selalu pakai urutan NAS pertama & kedua
                        // agar tampilan konsisten walau halaman di-refresh.
                        const defaultNas1 = data.routers.length >= 1 ? Number(data.routers[0].id) : null;
                        const defaultNas2 = data.routers.length >= 2 ? Number(data.routers[1].id) : null;

                        selectedNAS1 = defaultNas1;
                        selectedNAS2 = defaultNas2;

                        select1.value = defaultNas1 ? String(defaultNas1) : '';
                        select2.value = defaultNas2 ? String(defaultNas2) : '';

                        // Lock selector supaya tetap statis sesuai urutan router.
                        select1.disabled = true;
                        select2.disabled = true;
                        select1.title = 'NAS selector dibuat statis (router urutan pertama)';
                        select2.title = 'NAS selector dibuat statis (router urutan kedua)';

                        // Tampilkan hanya selector yang relevan.
                        const c1 = document.getElementById('nasSelect1Container');
                        const c2 = document.getElementById('nasSelect2Container');
                        if (c1) c1.style.display = defaultNas1 ? 'flex' : 'none';
                        if (c2) c2.style.display = defaultNas2 ? 'flex' : 'none';

                        updateMonitoring(true);
                    }
                } catch (e) {
                    console.error('Error loading routers:', e);
                }
            }
            
            // NAS Selection handlers
            document.getElementById('nasSelect1').addEventListener('change', function() {
                selectedNAS1 = this.value ? parseInt(this.value) : null;
                if (selectedNAS1 && selectedNAS1 === selectedNAS2) {
                    alert('NAS yang sama tidak bisa dipilih dua kali!');
                    this.value = '';
                    selectedNAS1 = null;
                    return;
                }
                updateMonitoring(true); // Force recreate panels when selection changes
            });
            
            document.getElementById('nasSelect2').addEventListener('change', function() {
                selectedNAS2 = this.value ? parseInt(this.value) : null;
                if (selectedNAS2 && selectedNAS1 === selectedNAS2) {
                    alert('NAS yang sama tidak bisa dipilih dua kali!');
                    this.value = '';
                    selectedNAS2 = null;
                    return;
                }
                updateMonitoring(true); // Force recreate panels when selection changes
            });
            
            document.getElementById('refreshMonitoring').addEventListener('click', () => {
                updateMonitoring(false); // Refresh without spinner, just update values
            });
            
            // Format bytes
            function formatBytes(bytes) {
                if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
                if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
                if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
                if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
                return bytes.toFixed(0) + ' B';
            }
            
            // Create monitoring panel for one NAS
            function createMonitoringPanel(data, index) {
                if (!data || !data.success || !data.data) {
                        return `
                        <div class="col-md-12 mb-3">
                            <div class="card border-danger">
                                <div class="card-header bg-danger text-white">
                                    <strong>NAS ${index} - Error</strong>
                                </div>
                                <div class="card-body text-center text-muted">
                                    <i class="bi bi-exclamation-triangle" style="font-size: 2rem;"></i>
                                    <p class="mt-2">${data?.message || 'Gagal memuat data'}</p>
                                </div>
                            </div>
                        </div>
                    `;
                }
                
                const d = data.data;
                const routerName = d.routerName || 'Unknown Router';
                const routerIp = d.routerIp || 'N/A';
                const routerId = d.routerId || index;
                
                return `
                    <div class="col-md-12 mb-4" data-router-id="${routerId}">
                        <div class="row">
                            <!-- NAS Status & Basic Stats -->
                            <div class="col-lg-4 mb-3">
                                <div class="recent-card h-100 p-4">
                                    <div class="d-flex justify-content-between align-items-center mb-4">
                                        <h5 class="fw-bold m-0" style="color: var(--fg);"><i class="bi bi-router"></i> ${routerName}</h5>
                                        <span class="badge-status green d-flex align-items-center gap-1">
                                            <span class="spinner-grow spinner-grow-sm text-success" style="width: 0.5rem; height: 0.5rem;" role="status"></span>
                                            CONNECTED
                                        </span>
                                    </div>
                                    <div class="mb-3 text-muted small card-header-info">
                                        <div class="nas-detail-row">
                                            <span class="nas-detail-label">IP Address</span>
                                            <span class="nas-detail-val">${routerIp}</span>
                                        </div>
                                        <div class="nas-detail-row">
                                            <span class="nas-detail-label">Uptime</span>
                                            <span class="nas-detail-val">${d.uptimeFormatted || d.uptime || 'N/A'}</span>
                                        </div>
                                        <div class="nas-detail-row">
                                            <span class="nas-detail-label">Identity</span>
                                            <span class="nas-detail-val identity-val">${d.identity || 'N/A'}</span>
                                        </div>
                                        <div class="nas-detail-row mt-2 router-badges" style="display:flex; flex-wrap:wrap; gap:4px; border:none; padding:0;">
                                            ${d.boardName && d.boardName !== 'N/A' ? `<span class="badge bg-light text-dark"><i class="bi bi-cpu"></i> ${d.boardName}</span>` : ''}
                                            ${d.cpu && d.cpu !== 'N/A' ? `<span class="badge bg-light text-dark"><i class="bi bi-motherboard"></i> ${d.cpu}</span>` : ''}
                                            ${d.version && d.version !== 'N/A' ? `<span class="badge bg-light text-dark"><i class="bi bi-code-square"></i> ${d.version}</span>` : ''}
                                            ${d.voltage !== null && d.voltage > 0 ? `<span class="badge bg-light text-dark"><i class="bi bi-lightning"></i> ${d.voltage.toFixed(1)}V</span>` : ''}
                                            ${d.temperature !== null && d.temperature > 0 ? `<span class="badge bg-light text-dark"><i class="bi bi-thermometer-half"></i> ${d.temperature}°C</span>` : ''}
                                        </div>
                                    </div>
                                    
                                    <div class="mt-4" data-metric="cpu">
                                        <div class="nas-progress-wrap">
                                            <div class="nas-progress-label"><i class="bi bi-cpu"></i> CPU Load</div>
                                            <div class="nas-progress-val">${d.cpuLoad}%</div>
                                        </div>
                                        <div class="nas-progress-bg">
                                            <div class="nas-progress-bar bg-indigo" style="width: ${d.cpuLoad}%"></div>
                                        </div>
                                        <div class="text-end text-muted cpu-subtext" style="font-size:0.7rem;">${d.cpuCount} Core(s) @ ${d.cpuFrequency} MHz</div>
                                    </div>
                                    
                                    <div class="mt-3" data-metric="ram">
                                        <div class="nas-progress-wrap">
                                            <div class="nas-progress-label"><i class="bi bi-memory"></i> RAM Usage</div>
                                            <div class="nas-progress-val">${d.memoryUsedPercent}%</div>
                                        </div>
                                        <div class="nas-progress-bg">
                                            <div class="nas-progress-bar bg-emerald" style="width: ${d.memoryUsedPercent}%"></div>
                                        </div>
                                        <div class="text-end text-muted ram-subtext" style="font-size:0.7rem;">${d.memoryUsedMB.toFixed(1)} MB / ${d.totalMemoryMB.toFixed(1)} MB</div>
                                    </div>
                                    
                                    <div class="mt-3" data-metric="hdd">
                                        <div class="nas-progress-wrap">
                                            <div class="nas-progress-label"><i class="bi bi-hdd"></i> HDD Usage</div>
                                            <div class="nas-progress-val">${d.diskUsedPercent}%</div>
                                        </div>
                                        <div class="nas-progress-bg" style="margin-bottom: 0;">
                                            <div class="nas-progress-bar" style="background: var(--warning); width: ${d.diskUsedPercent}%"></div>
                                        </div>
                                        <div class="text-end text-muted hdd-subtext" style="font-size:0.7rem; margin-top:6px;">${d.diskUsedMB.toFixed(1)} MB / ${d.totalDiskMB.toFixed(1)} MB</div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Realtime Traffic Chart -->
                            <div class="col-lg-8 mb-3">
                                <div class="recent-card h-100 p-4">
                                    <div class="d-flex justify-content-between align-items-center mb-4">
                                        <div>
                                            <h5 class="fw-bold m-0" style="color: var(--fg);">Real-time Traffic</h5>
                                        </div>
                                        <div class="d-flex align-items-center gap-3">
                                            <select id="interfaceSelect${routerId}" class="form-select form-select-sm" style="width: 200px; font-size: 0.8rem;">
                                                <option value="">-- Pilih Interface --</option>
                                                ${d.interfaces ? d.interfaces.map(iface => `<option value="${iface.name}">${iface.name}</option>`).join('') : ''}
                                            </select>
                                        </div>
                                    </div>
                                    <div class="row">
                                        <div class="col-md-3">
                                            <div class="stats-info" id="interfaceTrafficStats${routerId}">
                                                <div class="small text-muted mb-1 fw-bold">RX (Receive)</div>
                                                <div class="fw-bold text-primary mb-3" style="font-size: 1.2rem;"><span id="rxCurrent${routerId}">0 Mbps</span></div>
                                                
                                                <div class="small text-muted mb-1 fw-bold">TX (Transmit)</div>
                                                <div class="fw-bold text-success mb-3" style="font-size: 1.2rem;"><span id="txCurrent${routerId}">0 Mbps</span></div>
                                                
                                                <div class="small text-muted" style="font-size:0.65rem;">
                                                    <div class="mb-1">Min RX: <span id="rxMin${routerId}">0</span> | Max: <span id="rxMax${routerId}">0</span></div>
                                                    <div>Min TX: <span id="txMin${routerId}">0</span> | Max: <span id="txMax${routerId}">0</span></div>
                                                </div>
                                                <div class="small text-muted mt-2" style="font-size:0.65rem;">
                                                    Avg RX: <span id="rxAvg${routerId}">0</span> | Avg TX: <span id="txAvg${routerId}">0</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="col-md-9">
                                            <div style="position: relative; height: clamp(220px, 42vw, 360px); background-color: transparent;">
                                                <canvas id="rxBytesChart${routerId}" style="max-height: 100%;"></canvas>
                                                <div id="noInterfaceSelected${routerId}" class="text-center text-muted py-5" style="display: none;">
                                                    <i class="bi bi-graph-up" style="font-size: 2rem;"></i>
                                                    <p class="mt-2">Pilih interface untuk melihat trafik</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
            
            // Update monitoring display - tanpa menghilangkan tampilan
            async function updateMonitoring(initialLoad = false) {
                const container = document.getElementById('monitoringContainer');
                
                if (!selectedNAS1 && !selectedNAS2) {
                    if (initialLoad) {
                        container.innerHTML = `
                            <div class="col-12 text-center text-muted py-5">
                                <i class="bi bi-router" style="font-size: 3rem;"></i>
                                <p class="mt-3">Pilih NAS untuk memulai monitoring</p>
                            </div>
                        `;
                    }
                    if (monitoringInterval) {
                        clearInterval(monitoringInterval);
                        monitoringInterval = null;
                    }
                    return;
                }
                
                // Untuk initial load, tampilkan spinner. Untuk update berikutnya, langsung update data
                if (initialLoad && container.children.length === 0 || container.querySelector('.spinner-border')) {
                    container.innerHTML = '<div class="col-12 text-center py-3"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div></div>';
                }
                
                try {
                    const routerIds = [];
                    if (selectedNAS1) routerIds.push(selectedNAS1);
                    if (selectedNAS2) routerIds.push(selectedNAS2);
                    
                    const res = await fetch(`/api/dashboard/resources-multi?router_ids=${routerIds.join(',')}`);
                    const result = await res.json();
                    
                    if (result.success && result.data) {
                        // Check if panels already exist
                        const existingPanels = container.querySelectorAll('[data-router-id]');
                        
                        if (existingPanels.length === 0 || initialLoad) {
                            // First load or no panels exist - create new panels
                            let html = '';
                            result.data.forEach((data, idx) => {
                                html += createMonitoringPanel(data, idx + 1);
                            });
                            container.innerHTML = html;
                            
                            // Create bar charts for Rx Bytes - dengan delay untuk memastikan canvas sudah ada
                            setTimeout(() => {
                                result.data.forEach((data, idx) => {
                                    if (data.success && data.data && data.data.interfaces && data.data.interfaces.length > 0) {
                                        const routerId = data.data.routerId || (idx + 1);
                                        const canvasId = `rxBytesChart${routerId}`;
                                        
                                        // Retry mechanism untuk memastikan canvas dan dropdown sudah ada
                                        function tryCreateChart(attempts = 0) {
                                            const canvas = document.getElementById(canvasId);
                                            const selectEl = document.getElementById(`interfaceSelect${routerId}`);
                                            if (canvas && selectEl) {
                                                console.log(`Creating chart for ${canvasId}`);
                                                createRxBytesChart(canvasId, data.data.interfaces);
                                            } else if (attempts < 5) {
                                                console.warn(`Canvas/Dropdown ${canvasId} not found, retrying... (attempt ${attempts + 1})`);
                                                setTimeout(() => tryCreateChart(attempts + 1), 200);
                                            } else {
                                                console.error(`Failed to find canvas/dropdown ${canvasId} after 5 attempts`);
                                            }
                                        }
                                        tryCreateChart();
                                    } else {
                                        console.warn(`No interfaces data for router ${data.data?.routerId || (idx + 1)}`);
                                    }
                                });
                            }, 200);
                        } else {
                            // Update existing panels without recreating structure
                            result.data.forEach((data, idx) => {
                                if (data.success && data.data) {
                                    updateMonitoringPanel(data.data, idx + 1);
                                    
                                    // Update interface chart
                                    if (data.data.interfaces && data.data.interfaces.length > 0) {
                                        const routerId = data.data.routerId || (idx + 1);
                                        const canvasId = `rxBytesChart${routerId}`;
                                        // Small delay to ensure DOM is ready
                                        setTimeout(() => {
                                            updateInterfaceChart(canvasId, routerId, data.data.interfaces);
                                        }, 50);
                                    }
                                } else {
                                    // Show error in existing panel
                                    const panel = container.querySelector(`[data-router-id="${data.routerId || (idx + 1)}"]`);
                                    if (panel) {
                                        const cardBody = panel.querySelector('.card-body');
                                        if (cardBody) {
                                            cardBody.innerHTML = `
                                                <div class="text-center text-danger py-3">
                                                    <i class="bi bi-exclamation-triangle"></i> ${data.message || 'Gagal memuat data'}
                                                </div>
                                            `;
                                        }
                                    }
                                }
                            });
                        }
                        
                        // Update last update time
                        document.getElementById('lastUpdate').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
                    } else {
                        if (initialLoad) {
                            container.innerHTML = `
                                <div class="col-12 text-center text-danger py-3">
                                    <i class="bi bi-exclamation-triangle"></i> ${result.message || 'Gagal memuat data'}
                                </div>
                            `;
                        }
                    }
                } catch (e) {
                    if (initialLoad) {
                        container.innerHTML = `
                            <div class="col-12 text-center text-danger py-3">
                                <i class="bi bi-exclamation-triangle"></i> Error: ${e.message}
                            </div>
                        `;
                    }
                    console.error('Error updating monitoring:', e);
                }
            }
            
            // Gauge chart instances storage (Plotly)
            const gaugeCharts = {};
            
            // Function to create Plotly gauge chart
            function createGaugeChart(elementId, value, maxValue, colors, title, unit) {
                const element = document.getElementById(elementId);
                if (!element) return null;
                
                const isTemperature = Array.isArray(colors) && colors.length === 3;
                
                let gaugeConfig = {
                    domain: { x: [0, 1], y: [0, 1] },
                    value: value,
                    title: { text: title, font: { size: 16, color: '#333' } },
                    type: "indicator",
                    mode: "gauge+number",
                    gauge: {
                        axis: { 
                            range: [null, maxValue],
                            tickwidth: 1,
                            tickcolor: "#666",
                            ticks: "outside",
                            tickmode: "linear",
                            tick0: 0,
                            dtick: maxValue / 5
                        },
                        bar: { 
                            color: isTemperature ? (value > 60 ? colors[2] : value > 50 ? colors[1] : colors[0]) : colors,
                            line: { color: "rgba(255,255,255,0.3)", width: 1 }
                        },
                        bgcolor: "rgba(0,0,0,0)",
                        borderwidth: 0,
                        bordercolor: "rgba(0,0,0,0)",
                        steps: [],
                        threshold: {
                            line: { color: "rgba(255,255,255,0.5)", width: 2 },
                            thickness: 0.75,
                            value: maxValue * 0.9
                        }
                    }
                };
                
                // Add color steps for temperature gauge
                if (isTemperature) {
                    const stepSize = maxValue / 3;
                    gaugeConfig.gauge.steps = [
                        { range: [0, 50], color: colors[0] }, // green
                        { range: [50, 60], color: colors[1] }, // yellow
                        { range: [60, maxValue], color: colors[2] } // red
                    ];
                } else {
                    // Single color with gradient effect
                    gaugeConfig.gauge.steps = [
                        { range: [0, maxValue * 0.7], color: "rgba(60,60,60,0.3)" },
                        { range: [maxValue * 0.7, maxValue], color: "rgba(60,60,60,0.5)" }
                    ];
                }
                
                const layout = {
                    width: element.offsetWidth || 300,
                    height: 240,
                    margin: { t: 40, r: 20, l: 20, b: 40 },
                    paper_bgcolor: "rgba(0,0,0,0)",
                    plot_bgcolor: "rgba(0,0,0,0)",
                    font: { 
                        color: "#333",
                        family: "Arial, sans-serif",
                        size: 14
                    }
                };
                
                // Update gauge bgcolor to transparent
                gaugeConfig.gauge.bgcolor = "rgba(0,0,0,0)";
                
                const config = {
                    responsive: true,
                    displayModeBar: false,
                    staticPlot: false,
                    animate: true
                };
                
                // Create or update Plotly gauge chart
                const chartElement = document.getElementById(elementId);
                if (!chartElement) {
                    console.warn(`Element ${elementId} not found for gauge chart`);
                    return null;
                }
                
                // Check if Plotly chart already exists on this element
                const hasPlotlyChart = chartElement.data && chartElement.data.length > 0;
                
                if (hasPlotlyChart && gaugeCharts[elementId]) {
                    // Update existing chart using Plotly.update (jangan recreate)
                    try {
                        const barColor = isTemperature ? (value > 60 ? colors[2] : value > 50 ? colors[1] : colors[0]) : colors;
                        
                        Plotly.update(elementId, {
                            value: value,
                            'gauge.bar.color': barColor
                        }, {
                            // Empty layout update - keep existing layout
                        }, {
                            ...config,
                            transition: {
                                duration: 500,
                                easing: 'cubic-in-out'
                            }
                        });
                    } catch (e) {
                        console.error(`Error updating Plotly chart ${elementId}:`, e);
                        // Jika update gagal, coba recreate (tapi ini seharusnya jarang terjadi)
                        try {
                            Plotly.newPlot(elementId, [gaugeConfig], layout, config);
                            gaugeCharts[elementId] = { elementId, maxValue, colors, isTemperature };
                        } catch (e2) {
                            console.error(`Error recreating Plotly chart ${elementId}:`, e2);
                        }
                    }
                } else {
                    // Create new chart - hanya jika belum ada
                    try {
                        Plotly.newPlot(elementId, [gaugeConfig], layout, config);
                        gaugeCharts[elementId] = { elementId, maxValue, colors, isTemperature };
                    } catch (e) {
                        console.error(`Error creating Plotly chart ${elementId}:`, e);
                        return null;
                    }
                }
                
                return gaugeCharts[elementId];
            }
            
            // Function to create all gauge charts for a router
            function createGaugeCharts(routerId, data) {
                // Temperature gauge (0-80°C)
                createGaugeChart(
                    `tempGauge${routerId}`,
                    data.temperature !== null && data.temperature > 0 ? data.temperature : 0,
                    80,
                    ['#22c55e', '#eab308', '#ef4444'], // green, yellow, red
                    'Temperature',
                    '°C'
                );
                
                // Network In gauge (0-1000 Mbps)
                createGaugeChart(
                    `networkInGauge${routerId}`,
                    data.totalNetworkInMbps || 0,
                    1000,
                    '#22c55e', // green
                    'Total Network Inbound',
                    'Mb/s'
                );
                
                // Network Out gauge (0-1000 Mbps)
                createGaugeChart(
                    `networkOutGauge${routerId}`,
                    data.totalNetworkOutMbps || 0,
                    1000,
                    '#f97316', // orange
                    'Total Network Outbound',
                    'Mb/s'
                );
            }
            
            // Function to update gauge charts
            function updateGaugeCharts(routerId, data) {
                // Check if elements exist before updating
                const tempElement = document.getElementById(`tempGauge${routerId}`);
                const networkInElement = document.getElementById(`networkInGauge${routerId}`);
                const networkOutElement = document.getElementById(`networkOutGauge${routerId}`);
                
                // Update temperature gauge only if element exists
                if (tempElement) {
                    const tempValue = data.temperature !== null && data.temperature > 0 ? data.temperature : 0;
                    createGaugeChart(
                        `tempGauge${routerId}`,
                        tempValue,
                        80,
                        ['#22c55e', '#eab308', '#ef4444'],
                        'Temperature',
                        '°C'
                    );
                }
                
                // Update network in gauge only if element exists
                if (networkInElement) {
                    const networkInValue = data.totalNetworkInMbps || 0;
                    createGaugeChart(
                        `networkInGauge${routerId}`,
                        networkInValue,
                        1000,
                        '#22c55e',
                        'Total Network Inbound',
                        'Mb/s'
                    );
                }
                
                // Update network out gauge only if element exists
                if (networkOutElement) {
                    const networkOutValue = data.totalNetworkOutMbps || 0;
                    createGaugeChart(
                        `networkOutGauge${routerId}`,
                        networkOutValue,
                        1000,
                        '#f97316',
                        'Total Network Outbound',
                        'Mb/s'
                    );
                }
            }
            
            // Update existing monitoring panel without recreating HTML
            function updateMonitoringPanel(data, index) {
                const routerId = data.routerId || index;
                const panel = document.querySelector(`[data-router-id="${routerId}"]`);
                if (!panel) return;
                
                // Update router info badges di header (Identity, Board Name, CPU, Version, Voltage)
                const cardHeader = panel.querySelector('.card-header');
                if (cardHeader) {
                    const titleDiv = cardHeader.querySelector('.d-flex > div:first-child');
                    if (titleDiv) {
                        // Always update identity jika data tersedia
                        // Debug log untuk identity
                        console.log(`[DEBUG] Update identity for router ${routerId}:`, data.identity);
                        
                        if (data.identity && data.identity !== 'N/A' && data.identity !== null && data.identity !== undefined) {
                            let identitySpan = titleDiv.querySelector('small.ms-2');
                            if (!identitySpan) {
                                identitySpan = document.createElement('small');
                                identitySpan.className = 'ms-2';
                                titleDiv.appendChild(identitySpan);
                            }
                            // Hanya update jika berbeda untuk menghindari flicker
                            const identityText = `(${data.identity})`;
                            if (identitySpan.textContent !== identityText) {
                                identitySpan.textContent = identityText;
                            }
                            identitySpan.style.display = 'inline';
                            identitySpan.style.visibility = 'visible';
                            identitySpan.style.opacity = '1';
                        } else {
                            // Hide identity jika tidak ada
                            const identitySpan = titleDiv.querySelector('small.ms-2');
                            if (identitySpan) {
                                identitySpan.style.display = 'none';
                            }
                        }
                    }
                    
                    // Update badges (Board Name, CPU, Version, Voltage) - hanya update jika infoDiv ada
                    const infoDiv = cardHeader.querySelector('.mt-2');
                    if (infoDiv) {
                        let badgesHtml = '';
                        if (data.boardName && data.boardName !== 'N/A') {
                            badgesHtml += `<span class="badge bg-light text-dark me-1"><i class="bi bi-cpu"></i> ${data.boardName}</span>`;
                        }
                        if (data.cpu && data.cpu !== 'N/A') {
                            badgesHtml += `<span class="badge bg-light text-dark me-1"><i class="bi bi-motherboard"></i> ${data.cpu}</span>`;
                        }
                        if (data.version && data.version !== 'N/A') {
                            badgesHtml += `<span class="badge bg-light text-dark me-1"><i class="bi bi-code-square"></i> ${data.version}</span>`;
                        }
                        if (data.voltage !== null && data.voltage > 0) {
                            badgesHtml += `<span class="badge bg-light text-dark"><i class="bi bi-lightning"></i> ${data.voltage.toFixed(1)}V</span>`;
                        }
                        // Hanya update jika ada perubahan untuk menghindari flicker
                        if (infoDiv.innerHTML !== badgesHtml) {
                            infoDiv.innerHTML = badgesHtml;
                        }
                    }
                }
                
                // Update RAM progress bar
                const ramBar = panel.querySelector('[data-metric="ram"] .nas-progress-bar');
                if (ramBar) {
                    ramBar.style.width = `${data.memoryUsedPercent}%`;
                    const ramVal = panel.querySelector('[data-metric="ram"] .nas-progress-val');
                    if (ramVal) ramVal.textContent = `${data.memoryUsedPercent}%`;
                    const ramText = panel.querySelector('[data-metric="ram"] .ram-subtext');
                    if (ramText) ramText.textContent = `${data.memoryUsedMB.toFixed(1)} MB / ${data.totalMemoryMB.toFixed(1)} MB`;
                }
                
                // Update CPU progress bar
                const cpuBar = panel.querySelector('[data-metric="cpu"] .nas-progress-bar');
                if (cpuBar) {
                    cpuBar.style.width = `${data.cpuLoad}%`;
                    const cpuVal = panel.querySelector('[data-metric="cpu"] .nas-progress-val');
                    if (cpuVal) cpuVal.textContent = `${data.cpuLoad}%`;
                    const cpuText = panel.querySelector('[data-metric="cpu"] .cpu-subtext');
                    if (cpuText) cpuText.textContent = `${data.cpuCount} Core(s) @ ${data.cpuFrequency} MHz`;
                }
                
                // Update HDD progress bar
                const hddBar = panel.querySelector('[data-metric="hdd"] .nas-progress-bar');
                if (hddBar) {
                    hddBar.style.width = `${data.diskUsedPercent}%`;
                    const hddVal = panel.querySelector('[data-metric="hdd"] .nas-progress-val');
                    if (hddVal) hddVal.textContent = `${data.diskUsedPercent}%`;
                    const hddText = panel.querySelector('[data-metric="hdd"] .hdd-subtext');
                    if (hddText) hddText.textContent = `${data.diskUsedMB.toFixed(1)} MB / ${data.totalDiskMB.toFixed(1)} MB`;
                }
            }
            
            // Start real-time traffic update untuk interface
            function startInterfaceTrafficUpdate(routerId, interfaceName, chartInstance) {
                // Stop existing interval jika ada
                if (interfaceUpdateIntervals[routerId] && interfaceUpdateIntervals[routerId][interfaceName]) {
                    clearInterval(interfaceUpdateIntervals[routerId][interfaceName]);
                }
                
                // Setup interval untuk update real-time setiap 5 detik
                if (!interfaceUpdateIntervals[routerId]) {
                    interfaceUpdateIntervals[routerId] = {};
                }
                
                interfaceUpdateIntervals[routerId][interfaceName] = setInterval(async () => {
                    try {
                        const res = await fetch(`/api/dashboard/interface-traffic?router_id=${routerId}&interface=${encodeURIComponent(interfaceName)}`);
                        const data = await res.json();
                        
                        if (data.success && data.data) {
                            const tsData = interfaceTrafficData[routerId][interfaceName];
                            if (!tsData) return;
                            
                            // Get chart instance from stored instances
                            const chart = chartInstance || (interfaceChartInstances[routerId] && interfaceChartInstances[routerId][interfaceName]);
                            if (!chart) return;
                            
                            const now = new Date();
                            const currentSecond = now.getSeconds();
                            
                            // Buat label dengan format HH:MM:SS untuk internal
                            const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const timeLabelShort = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            
                            // Tambahkan data baru
                            tsData.labels.push(timeLabel);
                            tsData.rxData.push(data.data.rxMbps);
                            tsData.txData.push(data.data.txMbps);
                            
                            // Update display labels - tampilkan label setiap 5 detik (kelipatan 5 detik: 0, 5, 10, 15, 20, dst)
                            if (currentSecond % 5 === 0 || currentSecond === 0) {
                                tsData.displayLabels.push(timeLabelShort);
                            } else {
                                // Untuk data point lainnya, gunakan string kosong
                                tsData.displayLabels.push('');
                            }
                            
                            // Hapus data lama jika melebihi maxPoints
                            if (tsData.labels.length > tsData.maxPoints) {
                                tsData.labels.shift();
                                tsData.rxData.shift();
                                tsData.txData.shift();
                                tsData.displayLabels.shift();
                            }
                            
                            // Pastikan ada minimal 1 label yang tidak kosong untuk chart tetap readable
                            const hasNonEmptyLabel = tsData.displayLabels.some(l => l !== '');
                            if (!hasNonEmptyLabel && tsData.displayLabels.length > 0) {
                                // Set label terakhir sebagai label yang terlihat dengan format HH:MM:SS
                                const timeLabelWithSeconds = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                tsData.displayLabels[tsData.displayLabels.length - 1] = timeLabelWithSeconds;
                            }
                            
                            // Update chart dengan display labels - tanpa animasi
                            chart.data.labels = tsData.displayLabels;
                            chart.data.datasets[0].data = tsData.rxData;
                            chart.data.datasets[1].data = tsData.txData;
                            
                            // Update tanpa animasi dan tanpa delay
                            chart.options.animation = false;
                            
                            // Update statistics
                            updateInterfaceTrafficStats(routerId, interfaceName, tsData.rxData, tsData.txData);
                            chart.update('none', { duration: 0 });
                        }
                    } catch (e) {
                        console.error(`Error updating interface traffic for ${interfaceName}:`, e);
                    }
                }, 5000); // Update setiap 5 detik untuk real-time
            }
            
            // Update Interface Traffic Statistics
            function updateInterfaceTrafficStats(routerId, interfaceName, rxData, txData) {
                if (!rxData || !txData || rxData.length === 0 || txData.length === 0) return;
                
                // Calculate RX statistics
                const rxCurrent = rxData[rxData.length - 1] || 0;
                const rxMin = Math.min(...rxData);
                const rxMax = Math.max(...rxData);
                const rxSum = rxData.reduce((a, b) => a + b, 0);
                const rxAvg = rxSum / rxData.length;
                
                // Calculate TX statistics
                const txCurrent = txData[txData.length - 1] || 0;
                const txMin = Math.min(...txData);
                const txMax = Math.max(...txData);
                const txSum = txData.reduce((a, b) => a + b, 0);
                const txAvg = txSum / txData.length;
                
                // Update RX stats
                const rxCurrentEl = document.getElementById(`rxCurrent${routerId}`);
                const rxMinEl = document.getElementById(`rxMin${routerId}`);
                const rxMaxEl = document.getElementById(`rxMax${routerId}`);
                const rxAvgEl = document.getElementById(`rxAvg${routerId}`);
                
                if (rxCurrentEl) rxCurrentEl.textContent = rxCurrent.toFixed(2) + ' Mbps';
                if (rxMinEl) rxMinEl.textContent = rxMin.toFixed(2) + ' Mbps';
                if (rxMaxEl) rxMaxEl.textContent = rxMax.toFixed(2) + ' Mbps';
                if (rxAvgEl) rxAvgEl.textContent = rxAvg.toFixed(2) + ' Mbps';
                
                // Update TX stats
                const txCurrentEl = document.getElementById(`txCurrent${routerId}`);
                const txMinEl = document.getElementById(`txMin${routerId}`);
                const txMaxEl = document.getElementById(`txMax${routerId}`);
                const txAvgEl = document.getElementById(`txAvg${routerId}`);
                
                if (txCurrentEl) txCurrentEl.textContent = txCurrent.toFixed(2) + ' Mbps';
                if (txMinEl) txMinEl.textContent = txMin.toFixed(2) + ' Mbps';
                if (txMaxEl) txMaxEl.textContent = txMax.toFixed(2) + ' Mbps';
                if (txAvgEl) txAvgEl.textContent = txAvg.toFixed(2) + ' Mbps';
                
                // Update title
                const titleEl = document.getElementById(`interfaceTrafficTitle${routerId}`);
                if (titleEl) titleEl.textContent = interfaceName;
            }
            
            // Stop interface traffic update
            function stopInterfaceTrafficUpdate(routerId, interfaceName) {
                if (interfaceUpdateIntervals[routerId] && interfaceUpdateIntervals[routerId][interfaceName]) {
                    clearInterval(interfaceUpdateIntervals[routerId][interfaceName]);
                    delete interfaceUpdateIntervals[routerId][interfaceName];
                }
                // Clean up chart instance
                if (interfaceChartInstances[routerId] && interfaceChartInstances[routerId][interfaceName]) {
                    delete interfaceChartInstances[routerId][interfaceName];
                }
            }
            
            // Update interface chart - update data untuk interface yang sedang dipilih
            function updateInterfaceChart(canvasId, routerId, interfaces) {
                // Store interface data untuk dropdown
                routerInterfaceData[routerId] = interfaces;
                
                // Get selected interface from dropdown
                const selectEl = document.getElementById(`interfaceSelect${routerId}`);
                if (selectEl && selectEl.value) {
                    // Stop update untuk interface sebelumnya jika ada
                    const previousInterface = selectEl.dataset.previousValue;
                    if (previousInterface && previousInterface !== selectEl.value) {
                        stopInterfaceTrafficUpdate(routerId, previousInterface);
                    }
                    selectEl.dataset.previousValue = selectEl.value;
                    
                    // Update chart dengan interface yang dipilih
                    createInterfaceChart(canvasId, routerId, selectEl.value);
                } else {
                    // Jika belum ada pilihan, sembunyikan chart
                    const canvas = document.getElementById(canvasId);
                    const noSelectionEl = document.getElementById(`noInterfaceSelected${routerId}`);
                    if (canvas) canvas.style.display = 'none';
                    if (noSelectionEl) noSelectionEl.style.display = 'block';
                }
            }
            
            // Store interface data per router for chart updates
            const routerInterfaceData = {};
            
            // Store time series data untuk setiap router dan interface
            const interfaceTrafficData = {}; // { routerId: { interfaceName: { labels: [], rxData: [], txData: [] } } }
            const interfaceUpdateIntervals = {}; // { routerId: { interfaceName: intervalId } }
            const interfaceChartInstances = {}; // { routerId: { interfaceName: chartInstance } }
            
            // Create interface traffic line chart (per interface dengan dropdown) - Time series dengan area fill
            function createInterfaceChart(canvasId, routerId, selectedInterfaceName = null) {
                const ctx = document.getElementById(canvasId);
                if (!ctx) {
                    console.error(`Canvas element not found: ${canvasId}`);
                    return;
                }
                
                // Destroy existing chart if any
                const existingChart = Chart.getChart(ctx);
                if (existingChart) {
                    existingChart.destroy();
                }
                
                // Stop update untuk interface sebelumnya jika ada
                if (interfaceChartInstances[routerId]) {
                    Object.keys(interfaceChartInstances[routerId]).forEach(ifaceName => {
                        if (ifaceName !== selectedInterfaceName) {
                            stopInterfaceTrafficUpdate(routerId, ifaceName);
                        }
                    });
                }
                
                // Hide/show no selection message
                const noSelectionEl = document.getElementById(`noInterfaceSelected${routerId}`);
                
                if (!selectedInterfaceName || !routerInterfaceData[routerId]) {
                    if (noSelectionEl) noSelectionEl.style.display = 'block';
                    ctx.style.display = 'none';
                    return;
                }
                
                if (noSelectionEl) noSelectionEl.style.display = 'none';
                ctx.style.display = 'block';
                
                const interfaces = routerInterfaceData[routerId];
                const selectedInterface = interfaces.find(i => i.name === selectedInterfaceName);
                
                if (!selectedInterface) {
                    if (noSelectionEl) noSelectionEl.style.display = 'block';
                    ctx.style.display = 'none';
                    return;
                }
                
                // Initialize time series data untuk interface ini jika belum ada
                if (!interfaceTrafficData[routerId]) {
                    interfaceTrafficData[routerId] = {};
                }
                if (!interfaceTrafficData[routerId][selectedInterfaceName]) {
                    interfaceTrafficData[routerId][selectedInterfaceName] = {
                        labels: [],
                        rxData: [],
                        txData: [],
                        displayLabels: [], // Label untuk ditampilkan di X-axis (setiap 5 menit)
                        maxPoints: 17280 // Simpan 17280 data points (24 jam * 60 menit * 12 update per menit = 17280 points untuk update setiap 5 detik)
                    };
                }
                
                const tsData = interfaceTrafficData[routerId][selectedInterfaceName];
                
                // Create time series line chart dengan area fill (seperti gambar)
                try {
                    // Get initial data point dari selectedInterface (convert bytes to Mbps)
                    // selectedInterface memiliki rxBytesPerSec dan txBytesPerSec
                    const initialRxMbps = (selectedInterface.rxBytesPerSec * 8) / 1000000; // bytes/sec * 8 = bits/sec, / 1e6 = Mbps
                    const initialTxMbps = (selectedInterface.txBytesPerSec * 8) / 1000000;
                    
                    // Tambahkan beberapa data point awal untuk membuat grafik langsung terlihat
                    if (tsData.labels.length === 0) {
                        const now = new Date();
                        // Buat 5 data point awal dengan nilai yang sama untuk grafik langsung muncul
                        for (let i = 4; i >= 0; i--) {
                            const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const timeLabelShort = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                            tsData.labels.push(timeLabel);
                            tsData.rxData.push(initialRxMbps);
                            tsData.txData.push(initialTxMbps);
                            
                            // Tampilkan label setiap 5 detik untuk data point awal
                            const currentSecond = now.getSeconds();
                            if (currentSecond % 5 === 0 || i === 0) {
                                // Format dengan detik: HH:MM:SS
                                const timeLabelWithSeconds = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                tsData.displayLabels.push(timeLabelWithSeconds);
                            } else {
                                tsData.displayLabels.push('');
                            }
                        }
                    }
                    
                    // Pastikan ada minimal 1 label yang tidak kosong untuk chart
                    const hasNonEmptyLabel = tsData.displayLabels.some(l => l !== '');
                    if (!hasNonEmptyLabel && tsData.displayLabels.length > 0) {
                        // Set label terakhir sebagai label yang terlihat
                        const now = new Date();
                        const timeLabelShort = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        tsData.displayLabels[tsData.displayLabels.length - 1] = timeLabelShort;
                    }
                    
                    // Pastikan data tidak kosong
                    if (tsData.rxData.length === 0 || tsData.txData.length === 0) {
                        console.error('Data kosong untuk chart:', { rx: tsData.rxData.length, tx: tsData.txData.length, labels: tsData.labels.length });
                        return;
                    }
                    
                    // TX biru, RX hijau
                    const rxColor = '#22c55e';
                    const txColor = '#3b82f6';
                    const gradientRx = ctx.getContext('2d').createLinearGradient(0, 0, 0, 320);
                    gradientRx.addColorStop(0, 'rgba(34, 197, 94, 0.40)');
                    gradientRx.addColorStop(1, 'rgba(34, 197, 94, 0.03)');
                    const gradientTx = ctx.getContext('2d').createLinearGradient(0, 0, 0, 320);
                    gradientTx.addColorStop(0, 'rgba(59, 130, 246, 0.40)');
                    gradientTx.addColorStop(1, 'rgba(59, 130, 246, 0.03)');
                    
                    const chart = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: tsData.displayLabels.length > 0 ? tsData.displayLabels : tsData.labels,
                            datasets: [
                                {
                                    label: 'rx',
                                    data: tsData.rxData,
                                    borderColor: rxColor,
                                    backgroundColor: gradientRx,
                                    borderWidth: 2,
                                    fill: true,
                                    tension: 0.35,
                                    pointRadius: 0,
                                    pointHoverRadius: 5,
                                    pointHitRadius: 12
                                },
                                {
                                    label: 'tx',
                                    data: tsData.txData,
                                    borderColor: txColor,
                                    backgroundColor: gradientTx,
                                    borderWidth: 2,
                                    fill: true,
                                    tension: 0.35,
                                    pointRadius: 0,
                                    pointHoverRadius: 5,
                                    pointHitRadius: 12
                                }
                            ]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: {
                                duration: 0 // Nonaktifkan animasi untuk menghindari kedipan
                            },
                            transitions: {
                                active: {
                                    animation: {
                                        duration: 0
                                    }
                                }
                            },
                            interaction: {
                                mode: 'index',
                                axis: 'x',
                                intersect: false
                            },
                            plugins: {
                                legend: {
                                    display: true,
                                    position: 'bottom',
                                    labels: {
                                        usePointStyle: true,
                                        padding: 15,
                                        font: {
                                            size: 12
                                        }
                                    }
                                },
                                tooltip: {
                                    displayColors: true,
                                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                                    borderColor: 'rgba(148, 163, 184, 0.35)',
                                    borderWidth: 1,
                                    padding: 12,
                                    callbacks: {
                                        label: function(context) {
                                            const name = String(context.dataset.label || '').toUpperCase();
                                            const mbps = Number(context.parsed.y || 0);
                                            const gbps = mbps / 1000;
                                            return `${name}: ${gbps.toFixed(2)} Gbps (${mbps.toFixed(1)} Mbps)`;
                                        }
                                    }
                                },
                                title: {
                                    display: true,
                                    text: selectedInterfaceName,
                                    font: {
                                        size: 14,
                                        weight: 'bold'
                                    },
                                    padding: {
                                        bottom: 10,
                                        top: 0
                                    },
                                    align: 'start' // Align ke kiri seperti di gambar
                                }
                            },
                            scales: {
                                x: {
                                    grid: {
                                        color: 'rgba(148,163,184,0.20)',
                                        lineWidth: 1
                                    },
                                    ticks: {
                                        maxTicksLimit: 20,
                                        font: {
                                            size: 9
                                        },
                                        color: '#666',
                                        callback: function(value, index) {
                                            const labels = this.chart.data.labels;
                                            if (!labels || labels.length === 0) return '';
                                            if (index >= labels.length) return '';
                                            const label = labels[index];
                                            return label || '';
                                        },
                                        autoSkip: false,
                                        maxRotation: 45,
                                        minRotation: 45
                                    }
                                },
                                y: {
                                    beginAtZero: true,
                                    title: {
                                        display: true,
                                        text: 'Gbps',
                                        font: {
                                            size: 11
                                        }
                                    },
                                    ticks: {
                                        callback: function(value) {
                                            return (Number(value) / 1000).toFixed(1) + ' Gbps';
                                        },
                                        font: {
                                            size: 10
                                        },
                                        color: '#666',
                                        stepSize: 100
                                    },
                                    grid: {
                                        color: 'rgba(148,163,184,0.20)',
                                        lineWidth: 1,
                                        drawBorder: false
                                    }
                                }
                            }
                        }
                    });
                    
                    // Store chart instance
                    if (!interfaceChartInstances[routerId]) {
                        interfaceChartInstances[routerId] = {};
                    }
                    interfaceChartInstances[routerId][selectedInterfaceName] = chart;
                    
                    // Update statistics dengan data awal
                    if (tsData.rxData.length > 0 && tsData.txData.length > 0) {
                        updateInterfaceTrafficStats(routerId, selectedInterfaceName, tsData.rxData, tsData.txData);
                    }
                    
                    // Start real-time update untuk interface ini
                    startInterfaceTrafficUpdate(routerId, selectedInterfaceName, chart);
                } catch (e) {
                    console.error(`Error creating chart for ${canvasId}:`, e);
                }
            }
            
            // Legacy function untuk backward compatibility (tidak dipakai lagi)
            function createRxBytesChart(canvasId, interfaces) {
                // Store interface data
                const routerId = canvasId.replace('rxBytesChart', '');
                routerInterfaceData[routerId] = interfaces;
                
                // Setup dropdown handler
                const selectEl = document.getElementById(`interfaceSelect${routerId}`);
                if (selectEl) {
                    // Remove existing handler
                    const newSelect = selectEl.cloneNode(true);
                    selectEl.parentNode.replaceChild(newSelect, selectEl);
                    
                    // Add new handler
                    newSelect.addEventListener('change', function() {
                        const selectedInterface = this.value;
                        // Stop update untuk interface sebelumnya
                        const previousInterface = this.dataset.previousValue;
                        if (previousInterface && previousInterface !== selectedInterface) {
                            stopInterfaceTrafficUpdate(routerId, previousInterface);
                        }
                        this.dataset.previousValue = selectedInterface;
                        createInterfaceChart(`rxBytesChart${routerId}`, routerId, selectedInterface);
                    });
                    
                    // Auto-select first interface jika belum ada pilihan
                    if (!newSelect.value && interfaces.length > 0) {
                        newSelect.value = interfaces[0].name;
                        createInterfaceChart(`rxBytesChart${routerId}`, routerId, interfaces[0].name);
                    }
                }
            }
            
            // Auto refresh every 30 seconds - dioptimasi untuk mengurangi beban API MikroTik (dari 5 detik)
            function startAutoRefresh() {
                if (monitoringInterval) clearInterval(monitoringInterval);
                monitoringInterval = setInterval(() => updateMonitoring(false), 30000); // 30 detik (dioptimasi untuk mengurangi beban API MikroTik)
            }
            
            // Initialize — tunda agar halaman dashboard tampil dulu (NAS monitoring tidak blocking)
            setTimeout(() => {
                loadRouters().then(() => {
                    updateMonitoring(true);
                    startAutoRefresh();
                });
            }, 2500);
            // Grafik bandwidth real-time dengan 3 chart terpisah
            const maxPoints = 30; // tampilkan 30 data terakhir
            let currentInterface = localStorage.getItem('selectedInterface') || '05-ether2-ISP';
            
            // Utility function untuk format bandwidth
            function formatBandwidth(bytesPerSec) {
              if (bytesPerSec >= 1000000000) { // 1 Gbps
                return (bytesPerSec / 1000000000).toFixed(2) + ' Gbps';
              } else if (bytesPerSec >= 1000000) { // 1 Mbps
                return (bytesPerSec / 1000000).toFixed(2) + ' Mbps';
              } else if (bytesPerSec >= 1000) { // 1 Kbps
                return (bytesPerSec / 1000).toFixed(2) + ' Kbps';
              } else {
                return bytesPerSec.toFixed(2) + ' bps';
              }
            }
            
            // Utility function untuk format bandwidth tanpa unit (untuk chart)
            // Menggunakan unit yang sama dengan summary boxes untuk konsistensi
            function formatBandwidthValue(bytesPerSec) {
              if (bytesPerSec >= 1000000000) { // 1 Gbps
                return (bytesPerSec / 1000000000).toFixed(3);
              } else if (bytesPerSec >= 1000000) { // 1 Mbps
                return (bytesPerSec / 1000000).toFixed(3);
              } else if (bytesPerSec >= 1000) { // 1 Kbps
                return (bytesPerSec / 1000).toFixed(3);
              } else {
                return bytesPerSec.toFixed(3);
              }
            }
            
            // Utility function untuk mendapatkan unit yang sesuai dengan nilai aktual
            function getBandwidthUnitForValue(bytesPerSec) {
              if (bytesPerSec >= 1000000000) return 'Gbps';
              if (bytesPerSec >= 1000000) return 'Mbps';
              if (bytesPerSec >= 1000) return 'Kbps';
              return 'bps';
            }
            
            // Utility function untuk mendapatkan unit yang sesuai
            function getBandwidthUnit(bytesPerSec) {
              if (bytesPerSec >= 1000000000) return 'Gbps';
              if (bytesPerSec >= 1000000) return 'Mbps';
              if (bytesPerSec >= 1000) return 'Kbps';
              return 'bps';
            }
            
            // Chart Configuration
            const chartConfig = {
              type: 'line',
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 750, easing: 'easeInOutQuart' },
                transitions: { active: { animation: { duration: 300 } } },
                responsiveAnimationDuration: 0,
                hover: { animationDuration: 0 },
                plugins: { 
                  legend: { 
                    display: true,
                    position: 'top',
                    labels: { padding: 10, usePointStyle: true }
                  },
                  tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleColor: 'white',
                    bodyColor: 'white',
                    callbacks: {
                      label: function(context) {
                        const value = context.parsed.y;
                        // Gunakan unit yang sama dengan summary boxes
                        let unit = 'Kbps';
                        
                        // Tentukan unit berdasarkan nilai aktual
                        // Untuk nilai kecil (< 1), gunakan Kbps
                        // Untuk nilai sedang (1-1000), gunakan Mbps  
                        // Untuk nilai besar (> 1000), gunakan Gbps
                        if (value >= 1000) {
                          unit = 'Gbps';
                        } else if (value >= 1) {
                          unit = 'Mbps';
                        } else {
                          unit = 'Kbps';
                        }
                        
                        return context.dataset.label + ': ' + value.toFixed(2) + ' ' + unit;
                      }
                    }
                  }
                },
                scales: { 
                  y: { 
                    beginAtZero: true,
                    title: { display: true, text: 'Bandwidth', font: { size: 12 } },
                    ticks: {
                      callback: function(value) {
                        // Gunakan unit yang sama dengan summary boxes
                        let unit = 'Kbps';
                        
                        // Tentukan unit berdasarkan nilai aktual dalam chart
                        // Untuk nilai kecil (< 1), gunakan Kbps
                        // Untuk nilai sedang (1-1000), gunakan Mbps
                        // Untuk nilai besar (> 1000), gunakan Gbps
                        if (value >= 1000) {
                          unit = 'Gbps';
                        } else if (value >= 1) {
                          unit = 'Mbps';
                        } else {
                          unit = 'Kbps';
                        }
                        
                        return value + ' ' + unit;
                      },
                      font: { size: 10 }
                    },
                    grid: { color: 'rgba(0,0,0,0.1)' }
                  },
                  x: {
                    title: { display: true, text: 'Time', font: { size: 12 } },
                    ticks: { font: { size: 10 } },
                    grid: { color: 'rgba(0,0,0,0.1)' },
                    min: 0,
                    max: maxPoints - 1
                  }
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                elements: {
                  point: { radius: 0, hoverRadius: 4 },
                  line: { borderWidth: 2 }
                },
                performance: { maxDataPoints: maxPoints, maxDatasetPoints: maxPoints }
              }
            };
            
            // Initialize Charts
            let rxChart, txChart, combinedChart;
            
            // RX Chart (Download)
            const rxCtx = document.getElementById('rxChart').getContext('2d');
            rxChart = new Chart(rxCtx, {
              ...chartConfig,
              data: {
                labels: [],
                datasets: [{
                  label: 'Download (RX)',
                  data: [],
                  fill: true,
                  backgroundColor: 'rgba(13,202,240,0.2)',
                  borderColor: 'rgba(13,202,240,1)',
                  tension: 0.4,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  borderWidth: 2
                }]
              }
            });
            
            // TX Chart (Upload)
            const txCtx = document.getElementById('txChart').getContext('2d');
            txChart = new Chart(txCtx, {
              ...chartConfig,
              data: {
                labels: [],
                datasets: [{
                  label: 'Upload (TX)',
                  data: [],
                  fill: true,
                  backgroundColor: 'rgba(40,167,69,0.2)',
                  borderColor: 'rgba(40,167,69,1)',
                  tension: 0.4,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  borderWidth: 2
                }]
              }
            });
            
            // Combined Chart
            const combinedCtx = document.getElementById('combinedChart').getContext('2d');
            combinedChart = new Chart(combinedCtx, {
              ...chartConfig,
              data: {
                labels: [],
                datasets: [
                  {
                    label: 'Download (RX)',
                    data: [],
                    fill: false,
                    backgroundColor: 'rgba(13,202,240,0.2)',
                    borderColor: 'rgba(13,202,240,1)',
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    borderWidth: 2
                  },
                  {
                    label: 'Upload (TX)',
                    data: [],
                    fill: false,
                    backgroundColor: 'rgba(40,167,69,0.2)',
                    borderColor: 'rgba(40,167,69,1)',
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    borderWidth: 2
                  }
                ]
              }
            });

function addTrafficData(rx, tx, interface) {
  const now = new Date();
  const label = now.toLocaleTimeString('id-ID', { hour12: false });
  
  // Validasi dan konversi data
  const rxBytes = parseInt(rx) || 0;
  const txBytes = parseInt(tx) || 0;
  
  // Format bandwidth untuk display
  const rxFormatted = formatBandwidth(rxBytes);
  const txFormatted = formatBandwidth(txBytes);
  const totalFormatted = formatBandwidth(rxBytes + txBytes);
  
  // Debug logging untuk troubleshooting
  console.log(`[Traffic] Data [${interface}]:`, {
    raw: { rx: rxBytes, tx: txBytes },
    formatted: { rx: rxFormatted, tx: txFormatted, total: totalFormatted },
    time: label
  });
  
  // Update real-time info dengan format yang sesuai
  document.getElementById('currentRx').textContent = rxFormatted;
  document.getElementById('currentTx').textContent = txFormatted;
  document.getElementById('currentTotal').textContent = totalFormatted;
  
  // Update status berdasarkan traffic (support bandwidth tinggi)
  const statusElement = document.getElementById('currentStatus');
  const totalMbps = (rxBytes + txBytes) / 1000000;
  
  if (totalMbps > 1000) { // > 1 Gbps
    statusElement.textContent = 'Ultra High';
    statusElement.parentElement.parentElement.className = 'card bg-danger text-white';
  } else if (totalMbps > 500) { // > 500 Mbps
    statusElement.textContent = 'Very High';
    statusElement.parentElement.parentElement.className = 'card bg-danger text-white';
  } else if (totalMbps > 100) { // > 100 Mbps
    statusElement.textContent = 'High';
    statusElement.parentElement.parentElement.className = 'card bg-warning text-white';
  } else if (totalMbps > 10) { // > 10 Mbps
    statusElement.textContent = 'Medium';
    statusElement.parentElement.parentElement.className = 'card bg-info text-white';
  } else if (totalMbps > 1) { // > 1 Mbps
    statusElement.textContent = 'Low';
    statusElement.parentElement.parentElement.className = 'card bg-secondary text-white';
  } else {
    statusElement.textContent = 'Idle';
    statusElement.parentElement.parentElement.className = 'card bg-secondary text-white';
  }
  
  // Update semua chart
  updateAllCharts(label, rxBytes, txBytes);
  
  // Log status chart update
  console.log(`[Charts] Updated: RX: ${rxFormatted}, TX: ${txFormatted}`);
}

function updateAllCharts(label, rxBytes, txBytes) {
  // Convert to appropriate unit for charts - gunakan unit yang sama dengan summary boxes
  const rxValue = formatBandwidthValue(rxBytes);
  const txValue = formatBandwidthValue(txBytes);
  
  // Debug logging untuk memastikan konsistensi
  console.log(`[Chart] Data Conversion:`, {
    raw: { rx: rxBytes, tx: txBytes },
    converted: { rx: rxValue, tx: txValue },
    rxFormatted: formatBandwidth(rxBytes),
    txFormatted: formatBandwidth(txBytes)
  });
  
  // Update RX Chart
  updateChart(rxChart, label, rxValue, 'RX');
  
  // Update TX Chart
  updateChart(txChart, label, txValue, 'TX');
  
  // Update Combined Chart
  updateCombinedChart(label, rxValue, txValue);
}

function updateChart(chart, label, value, type) {
  // Remove old data if needed
  if (chart.data.labels.length >= maxPoints) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  
  // Add new data
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(parseFloat(value));
  
  // Update chart
  chart.update('none');
  
  // Auto-scroll
  if (chart.data.labels.length >= maxPoints) {
    chart.options.scales.x.min = chart.data.labels.length - maxPoints;
    chart.options.scales.x.max = chart.data.labels.length - 1;
  }
  
  // Auto-adjust Y-axis
  adjustChartYAxis(chart);
}

function updateCombinedChart(label, rxValue, txValue) {
  // Remove old data if needed
  if (combinedChart.data.labels.length >= maxPoints) {
    combinedChart.data.labels.shift();
    combinedChart.data.datasets[0].data.shift();
    combinedChart.data.datasets[1].data.shift();
  }
  
  // Add new data
  combinedChart.data.labels.push(label);
  combinedChart.data.datasets[0].data.push(parseFloat(rxValue));
  combinedChart.data.datasets[1].data.push(parseFloat(txValue));
  
  // Update chart
  combinedChart.update('none');
  
  // Auto-scroll
  if (combinedChart.data.labels.length >= maxPoints) {
    combinedChart.options.scales.x.min = combinedChart.data.labels.length - maxPoints;
    combinedChart.options.scales.x.max = combinedChart.data.labels.length - 1;
  }
  
  // Auto-adjust Y-axis
  adjustChartYAxis(combinedChart);
}

function adjustChartYAxis(chart) {
  if (chart.data.datasets[0].data.length === 0) return;
  
  // Get all data from all datasets
  let allData = [];
  chart.data.datasets.forEach(dataset => {
    allData = allData.concat(dataset.data);
  });
  
  if (allData.length === 0) return;
  
  // Calculate min and max
  const minValue = Math.min(...allData);
  const maxValue = Math.max(...allData);
  
  // Handle very small values
  if (maxValue <= 0.001) {
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 1;
    return;
  }
  
  // Untuk nilai Kbps (100-1000), gunakan skala yang lebih sesuai
  let newMin, newMax;
  
  if (maxValue >= 1000) {
    // Nilai dalam Kbps, gunakan skala 0-2000 Kbps
    newMin = 0;
    newMax = Math.max(2000, maxValue * 1.2);
  } else if (maxValue >= 1) {
    // Nilai dalam Mbps, gunakan skala 0-10 Mbps
    newMin = 0;
    newMax = Math.max(10, maxValue * 1.2);
  } else {
    // Nilai dalam Gbps, gunakan skala 0-2 Gbps
    newMin = 0;
    newMax = Math.max(2, maxValue * 1.2);
  }
  
  // Update if significant change
  if (Math.abs(chart.options.scales.y.min - newMin) > 0.1 || 
      Math.abs(chart.options.scales.y.max - newMax) > 0.1) {
    
    chart.options.scales.y.min = newMin;
    chart.options.scales.y.max = newMax;
    
    console.log(`[Chart] Y-axis adjusted: ${newMin.toFixed(3)} - ${newMax.toFixed(3)}`);
  }
}

function resetAllCharts() {
  // Reset semua chart data ketika interface berubah
  rxChart.data.labels = [];
  rxChart.data.datasets[0].data = [];
  rxChart.update('none');
  
  txChart.data.labels = [];
  txChart.data.datasets[0].data = [];
  txChart.update('none');
  
  combinedChart.data.labels = [];
  combinedChart.data.datasets[0].data = [];
  combinedChart.data.datasets[1].data = [];
  combinedChart.update('none');
  
  console.log('[Charts] All charts reset successfully');
}

async function fetchTraffic() {
  try {
    const res = await fetch(`/api/dashboard/traffic?interface=${currentInterface}`);
    const data = await res.json();
    if (data.success) {
      // Gunakan requestAnimationFrame untuk update yang lebih smooth
      requestAnimationFrame(() => {
        addTrafficData(data.rx, data.tx, data.interface);
      });
    }
  } catch (e) { 
    console.error('Error fetching traffic data:', e);
  }
}

// Load interface secara dinamis dari Mikrotik
async function loadInterfaces() {
  try {
    console.log('[Interface] Loading interfaces from Mikrotik...');
    const response = await fetch('/api/dashboard/interfaces');
    const data = await response.json();
    
    console.log('[Interface] API Response:', data);
    
    if (data.success && data.interfaces && data.interfaces.length > 0) {
      const select = document.getElementById('interfaceSelect');
      
      // Hapus semua option kecuali yang pertama (default)
      while (select.children.length > 1) {
        select.removeChild(select.lastChild);
      }
      
      // Tambahkan interface yang terdeteksi
      data.interfaces.forEach(iface => {
        const option = document.createElement('option');
        option.value = iface.name;
        
        // Buat label yang informatif
        let label = iface.name;
        
        // Tambahkan label khusus untuk interface tertentu
        if (iface.name === 'ether1-ISP') {
          label = 'ether1-ISP (ISP)';
        } else if (iface.name === 'ether2-CADANGAN ISP') {
          label = 'ether2-CADANGAN ISP (Backup)';
        } else if (iface.name === 'ether3-LOKAL') {
          label = 'ether3-LOKAL (Local)';
        } else if (iface.name === 'ether4-LOKAL-LEPTOP') {
          label = 'ether4-LOKAL-LEPTOP (Laptop)';
        } else if (iface.name === 'ether5-LOKAL-REMOT OLT') {
          label = 'ether5-LOKAL-REMOT OLT (Remote)';
        } else if (iface.name === 'ether6-OLT-SFP1-TANJUNGPURA') {
          label = 'ether6-OLT-SFP1-TANJUNGPURA (OLT1)';
        } else if (iface.name === 'ether7-OLT-SFP2-TANJUNGPURA2') {
          label = 'ether7-OLT-SFP2-TANJUNGPURA2 (OLT2)';
        } else if (iface.name === 'ether8-HOTSPOT-RADIO') {
          label = 'ether8-HOTSPOT-RADIO (Hotspot)';
        } else if (iface.name === 'ether9-HOTSPOT-SWICTHHUB') {
          label = 'ether9-HOTSPOT-SWICTHHUB (Switch)';
        } else if (iface.name === 'ether10-POP PEGAGAN/JANGGAR') {
          label = 'ether10-POP PEGAGAN/JANGGAR (POP)';
        } else if (iface.name === 'bridge1-HOTSPOT') {
          label = 'bridge1-HOTSPOT (Bridge)';
        } else if (iface.name === 'bridge2_OLT') {
          label = 'bridge2_OLT (Bridge OLT)';
        } else if (iface.name === 'vlan6-1100') {
          label = 'vlan6-1100 (VLAN)';
        }
        
        // Tambahkan status
        if (iface.disabled) {
          label += ' [Disabled]';
        } else if (!iface.running) {
          label += ' [Down]';
        } else {
          label += ' [Active]';
        }
        
        option.textContent = label;
        select.appendChild(option);
      });
      
      console.log(`[Interface] Loaded ${data.interfaces.length} interfaces from Mikrotik`);
      
      // Update current interface jika tidak ada di list
      const currentOption = select.querySelector(`option[value="${currentInterface}"]`);
      if (!currentOption && data.interfaces.length > 0) {
        currentInterface = data.interfaces[0].name;
        localStorage.setItem('selectedInterface', currentInterface);
        document.getElementById('currentInterface').textContent = currentInterface;
        select.value = currentInterface;
      }
      
    } else {
      console.warn('[Interface] Failed to load interfaces, using default options');
      console.warn('Response:', data);
    }
  } catch (error) {
    console.error('[Interface] Error loading interfaces:', error);
    console.error('Error details:', error.message);
  }
}

// Set interface yang tersimpan ke dropdown
document.getElementById('interfaceSelect').value = currentInterface;
document.getElementById('currentInterface').textContent = currentInterface;

// Event listener untuk perubahan interface
document.getElementById('interfaceSelect').addEventListener('change', function() {
  currentInterface = this.value;
  localStorage.setItem('selectedInterface', currentInterface); // Simpan ke localStorage
  document.getElementById('currentInterface').textContent = currentInterface; // Update tampilan
  console.log('Interface changed to:', currentInterface);
  resetAllCharts(); // Reset semua chart data
  fetchTraffic(); // Fetch data baru segera
});

// Load interfaces saat halaman dimuat
loadInterfaces();

// Set interval untuk update data - interval yang lebih optimal untuk grafik
setInterval(fetchTraffic, 30000); // Update setiap 30 detik - dioptimasi untuk mengurangi beban API MikroTik (dari 3 detik)
fetchTraffic(); // Fetch data pertama kali
// Fungsi untuk me-refresh logo dengan timestamp baru
function refreshLogo() {
    const logo = document.getElementById('logoImage');
    if (logo) {
        // Tambahkan parameter timestamp baru untuk memaksa reload gambar
        const timestamp = new Date().getTime();
        const src = logo.src.split('?')[0]; // Hapus parameter yang ada
        logo.src = `${src}?v=${timestamp}`;
    }
}

// Refresh logo setiap 30 detik - dioptimasi untuk mengurangi beban (dari 5 detik)
setInterval(refreshLogo, 30000);

// Refresh logo saat halaman dimuat
document.addEventListener('DOMContentLoaded', function() {
    refreshLogo();
});

// ========== SYSTEM INFORMATION DASHBOARD ==========
let systemInfoCharts = {};
let systemInfoHistory = {
    cpu: [],
    memory: [],
    virtualMemory: [],
    processes: [],
    diskIO: [],
    networkIO: [],
    timestamps: [],
    lastDiskIO: 0, // Store last cumulative value
    lastNetworkIO: 0 // Store last cumulative value
};

// Function to draw circular gauge
function drawGauge(canvasId, value, maxValue, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) - 10;
    const percentage = Math.min((value / maxValue) * 100, 100);
    const angle = (percentage / 100) * 2 * Math.PI - Math.PI / 2;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw background circle
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 15;
    ctx.stroke();
    
    // Draw value arc
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, -Math.PI / 2, angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    ctx.stroke();
}

// Function to format bytes
function formatBytes(bytes) {
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TiB';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GiB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MiB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KiB';
    return bytes.toFixed(0) + ' B';
}

// Function to create chart
function createSystemChart(canvasId, label, color, yAxisLabel, maxValue = null) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    
    const ctx = canvas.getContext('2d');
    // Convert color to rgba for background with opacity (lighter/translucent like in image)
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const bgColor = rgbMatch 
        ? `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, 0.2)`
        : color + '20';
    
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: label,
                data: [],
                borderColor: color,
                backgroundColor: bgColor,
                borderWidth: 1.5,
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                pointHoverRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: maxValue,
                    grid: {
                        color: 'rgba(0,0,0,0.1)',
                        lineWidth: 1
                    },
                    ticks: {
                        font: {
                            size: 10
                        },
                        color: '#666'
                    }
                },
                x: {
                    grid: {
                        color: 'rgba(0,0,0,0.1)',
                        lineWidth: 1
                    },
                    ticks: {
                        font: {
                            size: 9
                        },
                        color: '#666',
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

// Initialize charts
function initializeSystemCharts() {
    // Light blue/teal color for charts (like in the image): rgb(23, 162, 184) or lighter
    const chartColor = 'rgb(23, 162, 184)'; // Light blue/teal
    systemInfoCharts.cpu = createSystemChart('cpuChart', 'CPU', chartColor, '%', 100);
    systemInfoCharts.memory = createSystemChart('memoryChart', 'Real Memory', chartColor, '%', 100);
    systemInfoCharts.virtualMemory = createSystemChart('virtualMemoryChart', 'Virtual Memory', chartColor, '%', 100);
    systemInfoCharts.processes = createSystemChart('processChart', 'Processes', chartColor, 'Count', null);
    systemInfoCharts.diskIO = createSystemChart('diskIOChart', 'Disk I/O', chartColor, 'MiB', 200);
    systemInfoCharts.networkIO = createSystemChart('networkIOChart', 'Network I/O', chartColor, 'Mbps', 30);
}

// Helper function to calculate statistics
function calculateStats(dataArray) {
    if (dataArray.length === 0) return { min: 0, max: 0, avg: 0, current: 0 };
    const current = dataArray[dataArray.length - 1];
    const min = Math.min(...dataArray);
    const max = Math.max(...dataArray);
    const sum = dataArray.reduce((a, b) => a + b, 0);
    const avg = sum / dataArray.length;
    return { min, max, avg, current };
}

// Update charts with new data
function updateSystemCharts(data) {
    const now = new Date();
    const timeLabel = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    
    // Calculate disk I/O - use delta from previous cumulative measurement
    let diskIOValue = 0;
    if (data.diskIO) {
        const currentCumulative = (data.diskIO.read || 0) + (data.diskIO.write || 0);
        if (systemInfoHistory.lastDiskIO > 0) {
            // Calculate delta per 5 seconds (refresh interval), convert to per second
            const delta = currentCumulative - systemInfoHistory.lastDiskIO;
            diskIOValue = Math.max(0, delta / 5); // MiB per second
        }
        systemInfoHistory.lastDiskIO = currentCumulative;
    }
    
    // Calculate network I/O - use delta from previous cumulative measurement
    let networkIOValue = 0;
    if (data.networkIO) {
        const currentCumulative = (data.networkIO.rx || 0) + (data.networkIO.tx || 0);
        if (systemInfoHistory.lastNetworkIO > 0) {
            // Calculate delta per 5 seconds (refresh interval), convert to per second
            const delta = currentCumulative - systemInfoHistory.lastNetworkIO;
            networkIOValue = Math.max(0, delta / 5); // Mbps per second
        }
        systemInfoHistory.lastNetworkIO = currentCumulative;
    }
    
    // Add to history (keep last 30 points for better visualization)
    systemInfoHistory.timestamps.push(timeLabel);
    systemInfoHistory.cpu.push(data.cpu.usage);
    systemInfoHistory.memory.push(data.memory.percent);
    systemInfoHistory.virtualMemory.push(data.virtualMemory.percent);
    systemInfoHistory.processes.push(data.processes);
    systemInfoHistory.diskIO.push(diskIOValue);
    systemInfoHistory.networkIO.push(networkIOValue);
    
    // Keep only last 30 data points
    const maxPoints = 30;
    if (systemInfoHistory.timestamps.length > maxPoints) {
        systemInfoHistory.timestamps.shift();
        systemInfoHistory.cpu.shift();
        systemInfoHistory.memory.shift();
        systemInfoHistory.virtualMemory.shift();
        systemInfoHistory.processes.shift();
        systemInfoHistory.diskIO.shift();
        systemInfoHistory.networkIO.shift();
    }
    
    // Calculate and update statistics
    const cpuStats = calculateStats(systemInfoHistory.cpu);
    const memoryStats = calculateStats(systemInfoHistory.memory);
    const virtualMemoryStats = calculateStats(systemInfoHistory.virtualMemory);
    const processStats = calculateStats(systemInfoHistory.processes);
    const diskIOStats = calculateStats(systemInfoHistory.diskIO);
    const networkIOStats = calculateStats(systemInfoHistory.networkIO);
    
    // Update statistics displays
    document.getElementById('cpuCurrent').textContent = cpuStats.current + '%';
    document.getElementById('cpuMin').textContent = cpuStats.min.toFixed(1) + '%';
    document.getElementById('cpuMax').textContent = cpuStats.max.toFixed(1) + '%';
    document.getElementById('cpuAvg').textContent = cpuStats.avg.toFixed(1) + '%';
    
    document.getElementById('memoryCurrent').textContent = memoryStats.current + '%';
    document.getElementById('memoryMin').textContent = memoryStats.min.toFixed(1) + '%';
    document.getElementById('memoryMax').textContent = memoryStats.max.toFixed(1) + '%';
    document.getElementById('memoryAvg').textContent = memoryStats.avg.toFixed(1) + '%';
    
    document.getElementById('virtualMemoryCurrent').textContent = virtualMemoryStats.current + '%';
    document.getElementById('virtualMemoryMin').textContent = virtualMemoryStats.min.toFixed(1) + '%';
    document.getElementById('virtualMemoryMax').textContent = virtualMemoryStats.max.toFixed(1) + '%';
    document.getElementById('virtualMemoryAvg').textContent = virtualMemoryStats.avg.toFixed(1) + '%';
    
    document.getElementById('processCurrent').textContent = processStats.current;
    document.getElementById('processMin').textContent = Math.round(processStats.min);
    document.getElementById('processMax').textContent = Math.round(processStats.max);
    document.getElementById('processAvg').textContent = Math.round(processStats.avg);
    
    document.getElementById('diskIOCurrent').textContent = diskIOStats.current.toFixed(1) + ' MiB';
    document.getElementById('diskIOMin').textContent = diskIOStats.min.toFixed(1) + ' MiB';
    document.getElementById('diskIOMax').textContent = diskIOStats.max.toFixed(1) + ' MiB';
    document.getElementById('diskIOAvg').textContent = diskIOStats.avg.toFixed(1) + ' MiB';
    
    document.getElementById('networkIOCurrent').textContent = networkIOStats.current.toFixed(2) + ' Mbps';
    document.getElementById('networkIOMin').textContent = networkIOStats.min.toFixed(2) + ' Mbps';
    document.getElementById('networkIOMax').textContent = networkIOStats.max.toFixed(2) + ' Mbps';
    document.getElementById('networkIOAvg').textContent = networkIOStats.avg.toFixed(2) + ' Mbps';
    
    // Update charts
    if (systemInfoCharts.cpu) {
        systemInfoCharts.cpu.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.cpu.data.datasets[0].data = systemInfoHistory.cpu;
        systemInfoCharts.cpu.update('none');
    }
    
    if (systemInfoCharts.memory) {
        systemInfoCharts.memory.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.memory.data.datasets[0].data = systemInfoHistory.memory;
        systemInfoCharts.memory.update('none');
    }
    
    if (systemInfoCharts.virtualMemory) {
        systemInfoCharts.virtualMemory.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.virtualMemory.data.datasets[0].data = systemInfoHistory.virtualMemory;
        systemInfoCharts.virtualMemory.update('none');
    }
    
    if (systemInfoCharts.processes) {
        systemInfoCharts.processes.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.processes.data.datasets[0].data = systemInfoHistory.processes;
        systemInfoCharts.processes.update('none');
    }
    
    if (systemInfoCharts.diskIO) {
        systemInfoCharts.diskIO.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.diskIO.data.datasets[0].data = systemInfoHistory.diskIO;
        systemInfoCharts.diskIO.update('none');
    }
    
    if (systemInfoCharts.networkIO) {
        systemInfoCharts.networkIO.data.labels = systemInfoHistory.timestamps;
        systemInfoCharts.networkIO.data.datasets[0].data = systemInfoHistory.networkIO;
        systemInfoCharts.networkIO.update('none');
    }
}

// Fetch and update system information
async function fetchSystemInfo() {
    try {
        const response = await fetch('/admin/dashboard/api/system-info');
        
        if (!response.ok) {
            console.error('HTTP error:', response.status, response.statusText);
            const text = await response.text();
            console.error('Response:', text.substring(0, 200));
            return;
        }
        
        const result = await response.json();
        
        if (!result.success) {
            console.error('Failed to fetch system info:', result.message);
            return;
        }
        
        const data = result.data;
        
        // Update gauges
        drawGauge('cpuGauge', data.cpu.usage, 100, '#36a2eb');
        drawGauge('memoryGauge', data.memory.percent, 100, '#ff6384');
        drawGauge('virtualMemoryGauge', data.virtualMemory.percent, 100, '#4bc0c0');
        
        // Find root disk
        const rootDisk = data.disk.find(d => d.mounted === '/') || data.disk[0];
        if (rootDisk) {
            drawGauge('diskGauge', rootDisk.percent, 100, '#9966ff');
        }
        
        // Update gauge values
        document.getElementById('cpuValue').textContent = data.cpu.usage + '%';
        document.getElementById('memoryValue').textContent = data.memory.percent + '%';
        document.getElementById('virtualMemoryValue').textContent = data.virtualMemory.percent + '%';
        if (rootDisk) {
            document.getElementById('diskValue').textContent = rootDisk.percent + '%';
        }
        
        // Update detailed information
        document.getElementById('sysHostname').textContent = data.hostname + ' (' + (data.network[0]?.ipv4 || 'N/A') + ')';
        document.getElementById('sysVersion').textContent = data.version;
        document.getElementById('sysTime').textContent = data.time;
        document.getElementById('sysProcessor').textContent = data.cpu.model + ', ' + data.cpu.cores + ' cores';
        document.getElementById('sysProcesses').textContent = data.processes;
        document.getElementById('sysRealMemory').textContent = 
            formatBytes(data.memory.used) + ' used / ' + 
            formatBytes(data.memory.cached || 0) + ' cached / ' + 
            formatBytes(data.memory.total) + ' total';
        if (rootDisk) {
            document.getElementById('sysDiskSpace').textContent = 
                formatBytes(rootDisk.used) + ' used / ' + 
                formatBytes(rootDisk.free) + ' free / ' + 
                formatBytes(rootDisk.total) + ' total';
        }
        
        document.getElementById('sysOS').textContent = data.os;
        document.getElementById('sysKernel').textContent = data.kernel + ' on ' + data.arch;
        document.getElementById('sysUptime').textContent = data.uptimeFormatted;
        document.getElementById('sysLoadAvg').textContent = 
            data.cpu.loadAvg['1min'] + ' (1 min) ' + 
            data.cpu.loadAvg['5min'] + ' (5 mins) ' + 
            data.cpu.loadAvg['15min'] + ' (15 mins)';
        document.getElementById('sysVirtualMemory').textContent = 
            formatBytes(data.virtualMemory.used) + ' used / ' + 
            formatBytes(data.virtualMemory.total) + ' total';
        
        // Update network interfaces table
        const networkTable = document.querySelector('#networkInterfacesTable tbody');
        if (networkTable && data.network.length > 0) {
            networkTable.innerHTML = data.network.map(iface => `
                <tr>
                    <td>${iface.name}</td>
                    <td>${iface.type}</td>
                    <td>${iface.interfaceSpeed || 'N/A'}</td>
                    <td>${iface.ipv4}</td>
                    <td>${iface.ipv6 && iface.ipv6.length > 0 ? iface.ipv6.join('<br>') : '-'}</td>
                    <td>${iface.netmask}</td>
                    <td>${iface.broadcast || '-'}</td>
                    <td>${iface.active ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>'}</td>
                </tr>
            `).join('');
        } else if (networkTable) {
            networkTable.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No network interfaces found</td></tr>';
        }
        
        // Update disk usage table
        const diskTable = document.querySelector('#diskUsageTable tbody');
        if (diskTable && data.disk.length > 0) {
            diskTable.innerHTML = data.disk.map(disk => `
                <tr>
                    <td>${disk.mounted}</td>
                    <td>${disk.type}</td>
                    <td>${disk.percent}% (${formatBytes(disk.free)})</td>
                    <td>${formatBytes(disk.used)}</td>
                    <td>${formatBytes(disk.total)}</td>
                </tr>
            `).join('');
        } else if (diskTable) {
            diskTable.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No disk information available</td></tr>';
        }
        
        // Update charts
        updateSystemCharts(data);
        
    } catch (error) {
        console.error('Error fetching system info:', error);
    }
}

function initSystemInfoDashboard() {
    if (typeof Chart === 'undefined') {
        setTimeout(initSystemInfoDashboard, 300);
        return;
    }
    initializeSystemCharts();
    fetchSystemInfo();
    setupSystemInfoRefresh();
}

// Tunda agar statistik utama dashboard tampil lebih dulu
document.addEventListener('DOMContentLoaded', function() {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(initSystemInfoDashboard, { timeout: 6000 });
    } else {
        setTimeout(initSystemInfoDashboard, 2000);
    }
});

// Setup refresh functionality
function setupSystemInfoRefresh() {
    // Refresh button
    const refreshBtn = document.getElementById('refreshSystemInfo');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', fetchSystemInfo);
    }
    
    // Auto-refresh every 30 seconds - dioptimasi untuk mengurangi beban API MikroTik (dari 5 detik)
    setInterval(fetchSystemInfo, 30000);
}