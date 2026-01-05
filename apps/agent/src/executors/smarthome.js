const { BaseExecutor } = require('./base');

class SmartHomeExecutor extends BaseExecutor {
    async execute(name, args) {
        const { db } = this.services;

        switch (name) {
            case 'lookupDevice': {
                const entityId = db.getDeviceAlias(args.alias);
                if (entityId) return { entityId: entityId };
                return { info: `No alias found for '${args.alias}'. Scan/Search HA first.` };
            }
            case 'learnDevice': {
                db.saveDeviceAlias(args.alias, args.entityId);
                return { success: true, info: `Saved alias '${args.alias}' -> '${args.entityId}'` };
            }
            case 'listDeviceAliases': {
                const aliases = db.listAliases();
                return { count: aliases.length, aliases };
            }
            case 'deleteDeviceAlias': {
                db.deleteAlias(args.alias);
                return { success: true, info: `Deleted alias '${args.alias}'` };
            }
            default: return null;
        }
    }
}

module.exports = { SmartHomeExecutor };
