-- Platform-wide settings for SaaS management portal

CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
