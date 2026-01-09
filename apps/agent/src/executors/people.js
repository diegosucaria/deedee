const { BaseExecutor } = require('./base');

class PeopleExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { db } = this.services;

        switch (name) {
            case 'listPeople':
                const people = db.listPeople();
                return { people: people.map(p => ({ id: p.id, name: p.name, phone: p.phone, relationship: p.relationship, notes: p.notes })) };

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
                    db.updatePerson(args.id, args.updates);
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

module.exports = { PeopleExecutor };
