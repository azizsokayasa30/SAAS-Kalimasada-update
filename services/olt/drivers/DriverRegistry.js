const GenericHttpApiDriver = require('./GenericHttpApiDriver');
const HuaweiDriver = require('./HuaweiDriver');
const ZteDriver = require('./ZteDriver');
const FiberhomeDriver = require('./FiberhomeDriver');
const VsolDriver = require('./VsolDriver');
const CDataDriver = require('./CDataDriver');
const RaisecomDriver = require('./RaisecomDriver');
const HSGQDriver = require('./HSGQDriver');
const HiosoDriver = require('./HiosoDriver');

const DRIVER_MAP = new Map([
    ['generic', GenericHttpApiDriver],
    ['generic_http', GenericHttpApiDriver],
    ['generic_http_api', GenericHttpApiDriver],
    ['huawei', HuaweiDriver],
    ['zte', ZteDriver],
    ['fiberhome', FiberhomeDriver],
    ['vsol', VsolDriver],
    ['cdata', CDataDriver],
    ['raisecom', RaisecomDriver],
    ['hsgq', HSGQDriver],
    ['hioso', HiosoDriver]
]);

function normalizeVendor(vendor) {
    return String(vendor || 'generic').trim().toLowerCase().replace(/\s+/g, '_');
}

function createDriver(context) {
    const method = context.olt.connection_method;
    const vendor = normalizeVendor(context.olt.vendor);
    if (method === 'http_api' || method === 'https_api') {
        const Driver = DRIVER_MAP.get(vendor) || GenericHttpApiDriver;
        return new Driver(context);
    }
    const Driver = DRIVER_MAP.get(vendor);
    if (!Driver) {
        const error = new Error(`No driver registered for vendor ${context.olt.vendor}`);
        error.code = 'unsupported_driver_operation';
        throw error;
    }
    return new Driver(context);
}

module.exports = {
    createDriver,
    normalizeVendor
};
