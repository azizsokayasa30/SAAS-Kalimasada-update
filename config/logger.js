    // Modul logger untuk aplikasi
    const fs = require('fs');
    const path = require('path');
    const { getSetting } = require('./settingsManager');

    const MAX_FILE_BYTES = 20 * 1024 * 1024;
    const RATE_WINDOW_MS = 30 * 1000;
    const RATE_MAP_MAX = 400;

    class Logger {
        constructor() {
            this.logDir = path.join(__dirname, '../logs');
            this.ensureLogDirectory();
            this.timezone = getSetting('log_timezone', 'Asia/Jakarta');
            this._rate = new Map();
            this._writeQueue = Promise.resolve();
            this._rotating = new Set();
        }

        ensureLogDirectory() {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        }

        getTimestamp() {
            const now = new Date();
            try {
                const formatted = now.toLocaleString('en-US', {
                    timeZone: this.timezone,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
                const match = formatted.match(/(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/);
                if (match) {
                    const [, month, day, year, hour, minute, second] = match;
                    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
                }
                return formatted;
            } catch (e) {
                return now.toISOString().replace('T', ' ').substring(0, 19);
            }
        }

        truncateStack(stack) {
            if (!stack) return undefined;
            return String(stack).split('\n').slice(0, 5).join('\n');
        }

        // Safe serializer to avoid circular references and huge dumps
        safeSerialize(data) {
            const seen = new WeakSet();

            const serializeError = (err) => ({
                name: err.name,
                message: err.message,
                code: err.code,
                stack: this.truncateStack(err.stack),
            });

            const serializeAxiosError = (err) => {
                const out = {
                    isAxiosError: true,
                    name: err.name,
                    message: err.message,
                    code: err.code,
                };
                if (err.config) {
                    out.config = {
                        method: err.config.method,
                        url: err.config.url,
                    };
                    if (err.config.data) {
                        const dataStr = typeof err.config.data === 'string' ? err.config.data : (() => { try { return JSON.stringify(err.config.data); } catch { return '[unserializable request data]'; } })();
                        out.config.data = dataStr.length > 400 ? dataStr.slice(0, 400) + '...<truncated>' : dataStr;
                    }
                }
                if (err.response) {
                    const respData = (() => {
                        try { return typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data); } catch { return '[unserializable response data]'; }
                    })();
                    out.response = {
                        status: err.response.status,
                        statusText: err.response.statusText,
                        data: respData && respData.length > 500 ? respData.slice(0, 500) + '...<truncated>' : respData,
                    };
                }
                return out;
            };

            const replacer = (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (seen.has(value)) return '[Circular]';
                    seen.add(value);
                }
                return value;
            };

            try {
                if (data instanceof Error) {
                    return JSON.stringify(serializeError(data));
                }
                if (data && typeof data === 'object' && (data.isAxiosError || (data.response && data.config))) {
                    return JSON.stringify(serializeAxiosError(data));
                }
                const json = JSON.stringify(data, replacer);
                return json && json.length > 1500 ? json.slice(0, 1500) + '...<truncated>' : json;
            } catch (e) {
                try { return String(data); } catch { return '[Unserializable data]'; }
            }
        }

        formatMessage(level, message, data = null) {
            const timestamp = this.getTimestamp();
            let logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

            if (data) {
                if (typeof data === 'object') {
                    logMessage += ` ${this.safeSerialize(data)}`;
                } else {
                    logMessage += ` - ${data}`;
                }
            }

            return logMessage;
        }

        rateLimit(level, message) {
            const key = `${level}:${String(message || '').slice(0, 180)}`;
            const now = Date.now();
            const prev = this._rate.get(key);
            if (!prev) {
                if (this._rate.size >= RATE_MAP_MAX) {
                    const oldest = this._rate.keys().next().value;
                    this._rate.delete(oldest);
                }
                this._rate.set(key, { lastLogged: now, suppressed: 0 });
                return { emit: true, extra: '' };
            }
            if (now - prev.lastLogged < RATE_WINDOW_MS) {
                prev.suppressed += 1;
                return { emit: false, extra: '' };
            }
            const extra = prev.suppressed > 0 ? ` (repeated ${prev.suppressed} times in last ${Math.round((now - prev.lastLogged) / 1000)}s)` : '';
            prev.lastLogged = now;
            prev.suppressed = 0;
            return { emit: true, extra };
        }

        rotateIfNeeded(logFile) {
            if (this._rotating.has(logFile)) return;
            this._rotating.add(logFile);
            fs.stat(logFile, (err, st) => {
                if (err || !st || st.size < MAX_FILE_BYTES) {
                    this._rotating.delete(logFile);
                    return;
                }
                const rotated = `${logFile}.1`;
                fs.rename(logFile, rotated, () => {
                    this._rotating.delete(logFile);
                });
            });
        }

        writeToFile(level, logMessage) {
            const logFile = path.join(this.logDir, `${level}.log`);
            this.rotateIfNeeded(logFile);
            this._writeQueue = this._writeQueue.then(
                () => new Promise((resolve) => {
                    fs.appendFile(logFile, logMessage + '\n', () => resolve());
                })
            ).catch(() => {});
        }

        emit(level, message, data = null) {
            const limited = this.rateLimit(level, message);
            if (!limited.emit) return;
            const logMessage = this.formatMessage(level, `${message}${limited.extra}`, data);
            if (level === 'error') {
                console.error(logMessage);
            } else if (level === 'warn') {
                console.warn(logMessage);
            } else {
                console.log(logMessage);
            }
            this.writeToFile(level, logMessage);
        }

        info(message, data = null) {
            this.emit('info', message, data);
        }

        warn(message, data = null) {
            this.emit('warn', message, data);
        }

        error(message, data = null) {
            this.emit('error', message, data);
        }

        debug(message, data = null) {
            if (process.env.NODE_ENV === 'development') {
                this.emit('debug', message, data);
            }
        }
    }

    const logger = new Logger();

    module.exports = logger;
