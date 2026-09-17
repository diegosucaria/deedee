const { BaseExecutor } = require('./base');

// The updatePerson fields tools-definition.js lists.
const PERSON_TOOL_FIELDS = Object.freeze(['name', 'phone', 'relationship', 'notes', 'metadata']);

class PeopleExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { db } = services;

        switch (name) {
            case 'listPeople':
                const listOpts = {};
                if (args.limit) listOpts.limit = args.limit;
                if (args.offset) listOpts.offset = args.offset;
                if (args.query) listOpts.query = args.query;
                const people = db.listPeople(listOpts);
                const total = db.countPeople();
                const result = { people: people.map(p => ({ id: p.id, name: p.name, phone: p.phone, relationship: p.relationship, notes: p.notes })), total };
                if (args.limit && people.length === args.limit) result.hasMore = true;
                return result;

            case 'getPerson':
                const person = db.getPerson(args.idOrPhone);
                if (!person) return { error: `Person not found: ${args.idOrPhone}` };
                return { person };

            case 'searchContacts':
            case 'searchPeople':
                const matches = db.searchPeople(args.query);
                // Return simplified list if too many, but typically ok.
                return { matches };

            case 'updatePerson':
                try {
                    // Only the fields the tool lists. Autopilot status and linked
                    // identifiers change through the dashboard, never through a
                    // model call: autopilot 'full' replies to a contact as the owner.
                    const updates = {};
                    const given = args.updates && typeof args.updates === 'object' ? args.updates : {};
                    for (const key of PERSON_TOOL_FIELDS) {
                        if (given[key] !== undefined) updates[key] = given[key];
                    }
                    if (Object.keys(updates).length === 0) {
                        return { error: `No fields to update. Allowed: ${PERSON_TOOL_FIELDS.join(', ')}.` };
                    }
                    db.updatePerson(args.id, updates);
                    return { success: true, message: `Updated person ${args.id}` };
                } catch (e) {
                    return { error: `Update failed: ${e.message}` };
                }

            case 'deletePerson':
                db.deletePerson(args.id);
                return { success: true, message: `Deleted person ${args.id}` };

            default: return null;
        }
    }
}

module.exports = { PeopleExecutor, PERSON_TOOL_FIELDS };
