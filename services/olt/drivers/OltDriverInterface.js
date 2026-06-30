class OltDriverInterface {
    constructor(context) {
        this.context = context;
    }

    unsupported(method) {
        const error = new Error(`${method} is not supported by this OLT driver/profile`);
        error.code = 'unsupported_driver_operation';
        throw error;
    }

    async connect() { return this.unsupported('connect'); }
    async disconnect() { return this.unsupported('disconnect'); }
    async getSystemInfo() { return this.unsupported('getSystemInfo'); }
    async getPonPorts() { return this.unsupported('getPonPorts'); }
    async getOnuList() { return this.unsupported('getOnuList'); }
    async getOnuDetail() { return this.unsupported('getOnuDetail'); }
    async getOnuStatus() { return this.unsupported('getOnuStatus'); }
    async getOnuOpticalPower() { return this.unsupported('getOnuOpticalPower'); }
    async getOnuSignal() { return this.unsupported('getOnuSignal'); }
    async getOnuDistance() { return this.unsupported('getOnuDistance'); }
    async getOnuMac() { return this.unsupported('getOnuMac'); }
    async getOnuIp() { return this.unsupported('getOnuIp'); }
    async enableOnu() { return this.unsupported('enableOnu'); }
    async disableOnu() { return this.unsupported('disableOnu'); }
    async rebootOnu() { return this.unsupported('rebootOnu'); }
    async unregisterOnu() { return this.unsupported('unregisterOnu'); }
    async syncData() { return this.unsupported('syncData'); }
}

module.exports = OltDriverInterface;
