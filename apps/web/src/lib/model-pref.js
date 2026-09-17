// The chat model picker. The saved preference is a model id the owner chose
// once; the provider config is the only list of ids that still exist.

export const MODEL_PREF_KEY = 'deedee_model_pref';
export const AUTO_MODEL = 'auto';

/**
 * The model id the picker should hold, given what was saved and what the
 * provider config offers. A saved id the config no longer names is dead: the
 * select would fall back to showing "Auto" while every message still carried
 * the retired id.
 * @param {string|null|undefined} saved id read from localStorage
 * @param {string[]} models ids the provider config lists
 * @returns {string} the id to use, 'auto' when the saved one is gone
 */
export function resolveModelPref(saved, models) {
    if (!saved || saved === AUTO_MODEL) return AUTO_MODEL;
    return (models || []).includes(saved) ? saved : AUTO_MODEL;
}

/**
 * Model ids the picker lists beside 'auto'. While the config loads, a saved
 * id stays on the list so the select never shows a value it does not hold.
 * @param {string[]} models ids the provider config lists
 * @param {string} selected id the picker holds
 * @returns {string[]}
 */
export function modelOptions(models, selected) {
    const list = models || [];
    if (!selected || selected === AUTO_MODEL || list.includes(selected)) return list;
    return [...list, selected];
}
