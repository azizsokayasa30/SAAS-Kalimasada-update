-- Warehouse (gudang) + installation jobs — tabel yang dibutuhkan modul teknisi/gudang

CREATE TABLE IF NOT EXISTS warehouse_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT DEFAULT '',
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS warehouse_inbound_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS warehouse_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    inbound_batch_id INTEGER NOT NULL,
    public_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'in_stock' CHECK(status IN ('in_stock','out')),
    outbound_at DATETIME,
    outbound_recipient TEXT,
    outbound_notes TEXT,
    outbound_employee_id INTEGER,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_wh_units_code ON warehouse_units(public_code);
CREATE INDEX IF NOT EXISTS idx_wh_units_item_status ON warehouse_units(item_id, status);
CREATE INDEX IF NOT EXISTS idx_wh_units_batch ON warehouse_units(inbound_batch_id);
CREATE INDEX IF NOT EXISTS idx_wh_batches_item ON warehouse_inbound_batches(item_id);
CREATE INDEX IF NOT EXISTS idx_wh_batches_created ON warehouse_inbound_batches(created_at);

CREATE TABLE IF NOT EXISTS installation_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number VARCHAR(50) UNIQUE,
    customer_name VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(20),
    customer_address TEXT,
    customer_id INTEGER,
    package_id INTEGER,
    installation_date DATE,
    installation_time VARCHAR(20),
    assigned_technician_id INTEGER,
    status VARCHAR(50) DEFAULT 'scheduled',
    priority VARCHAR(20) DEFAULT 'normal',
    notes TEXT,
    equipment_needed TEXT,
    estimated_duration INTEGER DEFAULT 120,
    created_by_admin_id INTEGER,
    completed_at DATETIME,
    completion_notes TEXT,
    customer_latitude DECIMAL(10, 8),
    customer_longitude DECIMAL(11, 8),
    assigned_at DATETIME,
    work_started_at DATETIME,
    work_duration_seconds INTEGER,
    tech_completion_latitude REAL,
    tech_completion_longitude REAL,
    install_cable_length_m REAL,
    install_ont_sticker_photo_path TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (assigned_technician_id) REFERENCES technicians(id)
);

CREATE TABLE IF NOT EXISTS installation_job_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    old_status VARCHAR(50),
    new_status VARCHAR(50) NOT NULL,
    changed_by_type VARCHAR(20) NOT NULL,
    changed_by_id INTEGER NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (job_id) REFERENCES installation_jobs(id)
);

CREATE TABLE IF NOT EXISTS installation_job_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    equipment_name VARCHAR(255) NOT NULL,
    quantity INTEGER DEFAULT 1,
    serial_number VARCHAR(100),
    status VARCHAR(50) DEFAULT 'prepared',
    notes TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (job_id) REFERENCES installation_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_installation_jobs_status ON installation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_installation_jobs_technician ON installation_jobs(assigned_technician_id);
CREATE INDEX IF NOT EXISTS idx_installation_jobs_date ON installation_jobs(installation_date);
CREATE INDEX IF NOT EXISTS idx_job_status_history_job ON installation_job_status_history(job_id);
