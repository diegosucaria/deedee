const { BaseExecutor } = require('./base');

class WardrobeExecutor extends BaseExecutor {
    constructor(services) {
        super(services);
        this.wardrobeService = services.wardrobe;
    }

    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const wardrobe = services.wardrobe;
        if (!wardrobe) return null;

        switch (name) {
            case 'add_garment':
                return this.add_garment(args, wardrobe);
            case 'list_garments':
                return this.list_garments(args, wardrobe);
            case 'get_garment':
                return this.get_garment(args, wardrobe);
            case 'search_garments':
                return this.search_garments(args, wardrobe);
            case 'update_garment':
                return this.update_garment(args, wardrobe);
            case 'delete_garment':
                return this.delete_garment(args, wardrobe);
            case 'confirm_brand':
                return this.confirm_brand(args, wardrobe);
            case 'analyze_outfit_photo':
                return this.analyze_outfit_photo(args, wardrobe);
            case 'recommend_outfit':
                return this.recommend_outfit(args, wardrobe);
            case 'like_outfit':
                return this.like_outfit(args, wardrobe);
            case 'list_outfits':
                return this.list_outfits(args, wardrobe);
            case 'visualize_outfit':
                return this.visualize_outfit(args, wardrobe);
            case 'set_reference_selfie':
                return this.set_reference_selfie(args, wardrobe);
            case 'get_user_profile':
                return this.get_user_profile(args, wardrobe);
            case 'update_user_profile':
                return this.update_user_profile(args, wardrobe);
            case 'critique_outfit':
                return this.critique_outfit(args, wardrobe);
            case 'pack_for_trip':
                return this.pack_for_trip(args, wardrobe);
            case 'get_trip':
                return this.get_trip(args, wardrobe);
            case 'list_trips':
                return this.list_trips(args, wardrobe);
            case 'start_trip':
                return this.start_trip(args, wardrobe);
            case 'complete_trip':
                return this.complete_trip(args, wardrobe);
            case 'set_trip_capsule':
                return this.set_trip_capsule(args, wardrobe);
            case 'add_to_trip_capsule':
                return this.add_to_trip_capsule(args, wardrobe);
            case 'remove_from_trip_capsule':
                return this.remove_from_trip_capsule(args, wardrobe);
            case 'add_to_shopping_list':
                return this.add_to_shopping_list(args, wardrobe);
            case 'list_shopping_items':
                return this.list_shopping_items(args, wardrobe);
            case 'mark_purchased':
                return this.mark_purchased(args, wardrobe);
            case 'dismiss_shopping_item':
                return this.dismiss_shopping_item(args, wardrobe);
            default:
                return null;
        }
    }

    async add_to_shopping_list({ description, type, primary_color, pattern, material_hint, context, priority } = {}, wardrobe) {
        if (!description) return 'Missing description.';
        try {
            const item = await wardrobe.addToShoppingList({
                description, type, primary_color, pattern, material_hint, context, priority
            });
            return `Added to shopping list: ${item.id} — ${item.description}`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async list_shopping_items({ status } = {}, wardrobe) {
        const items = wardrobe.db.listShoppingItems({ status: status || null });
        if (items.length === 0) return 'Shopping list is empty.';
        return items.map(i =>
            `- ${i.id} [${i.status}, ${i.priority}] ${i.description}${i.type ? ` (${i.type}${i.primary_color ? `, ${i.primary_color}` : ''})` : ''}`
        ).join('\n');
    }

    async mark_purchased({ id, garment_id } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const item = await wardrobe.markPurchased(id, garment_id || null);
            return `Marked ${item.id} purchased${garment_id ? ` (linked to garment ${garment_id})` : ''}.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async dismiss_shopping_item({ id } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const item = await wardrobe.dismissShoppingItem(id);
            return `Dismissed ${item.id}.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async pack_for_trip({ destination, start_date, end_date, activities, calendar_event_id } = {}, wardrobe) {
        if (!destination || !start_date || !end_date) return 'Missing destination, start_date, or end_date.';
        try {
            const trip = await wardrobe.packForTrip({
                destination,
                startDate: start_date,
                endDate: end_date,
                activities: Array.isArray(activities) ? activities : [],
                calendarEventId: calendar_event_id || null
            });
            const rationale = trip.weather_snapshot?.pack_rationale || '';
            return `Trip ${trip.id} planned. Capsule: ${(trip.planned_capsule || []).length} items.\n${rationale}`;
        } catch (e) {
            return `Error planning trip: ${e.message}`;
        }
    }

    async get_trip({ id } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        const t = wardrobe.db.getTrip(id);
        if (!t) return `Trip ${id} not found.`;
        return JSON.stringify(t, null, 2);
    }

    async list_trips({ status } = {}, wardrobe) {
        const trips = wardrobe.db.getTrips({ status: status || null });
        if (trips.length === 0) return 'No trips.';
        return trips.map(t =>
            `- ${t.id}: ${t.destination} (${t.start_date} → ${t.end_date}) [${t.status}]`
        ).join('\n');
    }

    async start_trip({ id } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const t = await wardrobe.startTrip(id);
            return `Started trip ${t.id}. Capsule: ${(t.actual_capsule || []).length} items.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async complete_trip({ id } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const t = await wardrobe.completeTrip(id);
            return `Completed trip ${t.id}.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async set_trip_capsule({ id, garment_ids } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const t = await wardrobe.setTripCapsule(id, Array.isArray(garment_ids) ? garment_ids : []);
            return `Set capsule for trip ${t.id}: ${(t.actual_capsule || []).length} items.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async add_to_trip_capsule({ id, garment_ids, image_base64, mime_type } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const t = await wardrobe.addToTripCapsule(id, {
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                imageBase64: image_base64 || null,
                mimeType: mime_type || 'image/jpeg'
            });
            return `Updated capsule for trip ${t.id}: ${(t.actual_capsule || []).length} items.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async remove_from_trip_capsule({ id, garment_ids } = {}, wardrobe) {
        if (!id) return 'Missing id.';
        try {
            const t = await wardrobe.removeFromTripCapsule(id, Array.isArray(garment_ids) ? garment_ids : []);
            return `Updated capsule for trip ${t.id}: ${(t.actual_capsule || []).length} items.`;
        } catch (e) { return `Error: ${e.message}`; }
    }

    async critique_outfit({ image_base64, mime_type, garment_ids, trip_id, question } = {}, wardrobe) {
        if (!image_base64 && (!Array.isArray(garment_ids) || garment_ids.length === 0)) {
            return 'Provide either image_base64 or garment_ids.';
        }
        try {
            const result = await wardrobe.critiqueOutfit({
                imageBase64: image_base64 || null,
                mimeType: mime_type || 'image/jpeg',
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                tripId: trip_id || null,
                question: question || ''
            });
            const lines = [
                `Score: ${result.score}/10`,
                result.strengths?.length ? `Strengths:\n${result.strengths.map(s => `  + ${s}`).join('\n')}` : null,
                result.weaknesses?.length ? `Weaknesses:\n${result.weaknesses.map(s => `  - ${s}`).join('\n')}` : null,
                result.better_alternative
                    ? `Better alternative: ${result.better_alternative.garment_ids.join(', ')}\n  ${result.better_alternative.rationale}`
                    : null
            ].filter(Boolean);
            return lines.join('\n');
        } catch (e) {
            return `Error critiquing outfit: ${e.message}`;
        }
    }

    async visualize_outfit({ garment_ids_panels, layout, outfit_id } = {}, wardrobe) {
        if (!garment_ids_panels) return 'Missing garment_ids_panels (array or array-of-arrays).';
        try {
            const result = await wardrobe.visualizeOutfit({
                garmentIdsPanels: garment_ids_panels,
                layout: layout || 'auto',
                outfitId: outfit_id || null
            });
            if (result.needs_reference) {
                return 'Please set a reference selfie first via set_reference_selfie.';
            }
            return `Rendered outfit ${result.outfit.id} (${result.panels} panel${result.panels === 1 ? '' : 's'}, layout=${result.layout}).`;
        } catch (e) {
            return `Error rendering outfit: ${e.message}`;
        }
    }

    async set_reference_selfie({ image_base64, mime_type } = {}, wardrobe) {
        if (!image_base64) return 'Missing image_base64.';
        try {
            const profile = await wardrobe.setReferenceSelfie(image_base64, mime_type || 'image/jpeg');
            return `Reference selfie saved. Profile updated.`;
        } catch (e) {
            return `Error saving reference: ${e.message}`;
        }
    }

    async get_user_profile(_args, wardrobe) {
        try {
            const p = wardrobe.db.getUserProfile();
            if (!p) return 'No profile yet.';
            return [
                `Preferred brands: ${(p.preferred_brands || []).join(', ') || 'none'}`,
                `Reference selfie: ${p.reference_image_path ? 'set' : 'not set'}`,
                `Morning outfit suggestions: ${p.morning_outfit_enabled ? 'ON' : 'OFF'}`,
                p.style_notes ? `Notes: ${p.style_notes}` : null
            ].filter(Boolean).join('\n');
        } catch (e) {
            return `Error reading profile: ${e.message}`;
        }
    }

    async update_user_profile({ patch } = {}, wardrobe) {
        if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
            return 'Missing patch fields.';
        }
        try {
            const ok = wardrobe.db.updateUserProfile(patch);
            if (!ok) return 'No valid fields to update.';
            const profile = wardrobe.db.getUserProfile();
            return `Profile updated. Morning outfit: ${profile.morning_outfit_enabled ? 'ON' : 'OFF'}. Preferred brands: ${(profile.preferred_brands || []).join(', ') || 'none'}.`;
        } catch (e) {
            return `Error updating profile: ${e.message}`;
        }
    }

    async recommend_outfit({ garment_ids, trip_id, context, count } = {}, wardrobe) {
        try {
            const result = await wardrobe.recommendOutfit({
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                tripId: trip_id || null,
                context: context || '',
                count: count || 4
            });
            if (!result.proposals || result.proposals.length === 0) {
                return result.notes || 'No proposals generated.';
            }
            const lines = result.proposals.map(p => {
                const ids = (p.outfit.garment_ids || []).join(', ');
                let line = `- [${p.bucket}] outfit ${p.outfit.id}: ${ids}\n  ${p.rationale}`;
                if (p.wants?.length) {
                    line += `\n  Wants: ${p.wants.map(w => w.description).join('; ')}`;
                }
                return line;
            });
            return `Suggested ${result.proposals.length} outfit(s):\n${lines.join('\n')}`;
        } catch (e) {
            return `Error recommending outfit: ${e.message}`;
        }
    }

    async like_outfit({ outfit_id, liked = true } = {}, wardrobe) {
        if (!outfit_id) return 'Missing outfit_id.';
        try {
            const out = await wardrobe.likeOutfit(outfit_id, liked);
            if (!out) return `Outfit ${outfit_id} not found.`;
            return `${liked ? 'Liked' : 'Unliked'} outfit ${outfit_id}.`;
        } catch (e) {
            return `Error updating outfit: ${e.message}`;
        }
    }

    async list_outfits({ liked } = {}, wardrobe) {
        try {
            const outfits = wardrobe.db.getOutfits({ liked: liked === undefined ? null : !!liked, limit: 100 });
            if (outfits.length === 0) return 'No outfits saved.';
            return outfits.map(o =>
                `- ${o.name || o.id} (${(o.garment_ids || []).length} items)${o.liked ? ' [liked]' : ''}`
            ).join('\n');
        } catch (e) {
            return `Error listing outfits: ${e.message}`;
        }
    }

    async analyze_outfit_photo({ image_base64, caption, trip_id, mime_type }, wardrobe) {
        if (!image_base64) return 'Missing image_base64.';
        try {
            const result = await wardrobe.analyzeOutfitPhoto(image_base64, {
                caption,
                tripId: trip_id,
                mimeType: mime_type || 'image/jpeg'
            });
            const lines = [
                `Matched ${result.matched.length} existing garment(s): ${result.matched.join(', ') || 'none'}`,
                `Added ${result.newly_added.length} new garment(s): ${result.newly_added.join(', ') || 'none'}`
            ];
            if (result.notes?.length) {
                lines.push('Shopping-list hits:');
                for (const n of result.notes) {
                    if (n.shopping_list_hit) {
                        lines.push(`  - ${n.garment_id} may be "${n.shopping_list_hit.description}" (shopping id ${n.shopping_list_hit.id})`);
                    }
                }
            }
            return lines.join('\n');
        } catch (e) {
            return `Error analyzing outfit photo: ${e.message}`;
        }
    }

    async confirm_brand({ garment_id, accept }, wardrobe) {
        if (!garment_id) return 'Missing garment_id.';
        try {
            const updated = await wardrobe.confirmBrand(garment_id, !!accept);
            return accept
                ? `Confirmed brand on ${updated.id}: ${updated.brand || 'none'}.`
                : `Rejected brand candidate on ${updated.id}.`;
        } catch (e) {
            return `Error confirming brand: ${e.message}`;
        }
    }

    async add_garment({ image_base64, mime_type }, wardrobe) {
        if (!image_base64) return 'Please provide a base64-encoded image (image_base64).';
        try {
            const created = await wardrobe.ingestGarmentFromBase64(image_base64, mime_type || 'image/jpeg');
            if (created.length === 0) return 'No garments detected in the image.';
            const list = created.map(g => {
                const bits = [g.type, g.subtype, g.primary_color].filter(Boolean).join(' ');
                return `- ${bits || 'unclassified garment'} (id: ${g.id})`;
            }).join('\n');
            return `Added ${created.length} garment(s) to your wardrobe:\n${list}`;
        } catch (e) {
            return `Failed to add garment: ${e.message}`;
        }
    }

    async list_garments({ limit, offset, type } = {}, wardrobe) {
        try {
            const garments = wardrobe.db.getGarments({
                limit: limit || 100,
                offset: offset || 0,
                type: type || null
            });
            if (garments.length === 0) return 'Your wardrobe is empty. Use add_garment to scan some clothes.';
            const list = garments.map(g => {
                const attrs = [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean).join(' · ');
                return `- ${attrs || 'unclassified'} (id: ${g.id})`;
            }).join('\n');
            return `Found ${garments.length} garment(s):\n${list}`;
        } catch (e) {
            return `Error listing garments: ${e.message}`;
        }
    }

    async get_garment({ id }, wardrobe) {
        try {
            const g = wardrobe.db.getGarment(id);
            if (!g) return `Garment "${id}" not found.`;
            const parts = [
                `**Garment ${g.id}**`,
                g.type && `Type: ${g.type}${g.subtype ? ` / ${g.subtype}` : ''}`,
                g.primary_color && `Color: ${g.primary_color}${g.secondary_colors?.length ? ` (+ ${g.secondary_colors.join(', ')})` : ''}`,
                g.pattern && `Pattern: ${g.pattern}`,
                g.material_guess && `Material: ${g.material_guess}`,
                (g.warmth || g.formality) && `Warmth: ${g.warmth || '?'}/5 · Formality: ${g.formality || '?'}/5`,
                g.season_tags?.length && `Seasons: ${g.season_tags.join(', ')}`,
                g.brand && `Brand: ${g.brand}${g.model ? ` (${g.model})` : ''}`,
                g.size && `Size: ${g.size}`,
                g.fit_notes && `Notes: ${g.fit_notes}`,
                `Status: ${g.enrichment_status}`
            ].filter(Boolean);
            return parts.join('\n');
        } catch (e) {
            return `Error getting garment: ${e.message}`;
        }
    }

    async search_garments({ query }, wardrobe) {
        try {
            const garments = wardrobe.db.searchGarments(query);
            if (garments.length === 0) return `No garments matched "${query}".`;
            const list = garments.map(g => {
                const attrs = [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean).join(' · ');
                return `- ${attrs || 'unclassified'} (id: ${g.id})`;
            }).join('\n');
            return `Found ${garments.length} garment(s) matching "${query}":\n${list}`;
        } catch (e) {
            return `Error searching garments: ${e.message}`;
        }
    }

    async update_garment({ id, patch }, wardrobe) {
        if (!id) return 'Missing garment id.';
        if (!patch || typeof patch !== 'object') return 'Missing patch fields.';
        try {
            const ok = wardrobe.db.updateGarment(id, patch);
            if (!ok) return `Garment "${id}" not found or no updatable fields provided.`;
            const updated = wardrobe.db.getGarment(id);
            wardrobe._broadcast('wardrobe:garment:update', updated);
            return `Updated garment ${id}.`;
        } catch (e) {
            return `Error updating garment: ${e.message}`;
        }
    }

    async delete_garment({ id }, wardrobe) {
        if (!id) return 'Missing garment id.';
        try {
            const ok = wardrobe.db.deleteGarment(id);
            if (!ok) return `Garment "${id}" not found.`;
            wardrobe._broadcast('wardrobe:garment:delete', { id });
            return `Deleted garment ${id}.`;
        } catch (e) {
            return `Error deleting garment: ${e.message}`;
        }
    }
}

module.exports = { WardrobeExecutor };
