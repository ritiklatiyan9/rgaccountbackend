/** One registry choice per name, with every known phone available for search. */
export const registryFarmerUsers = (people, savedNames = []) => {
  const byName = new Map();
  for (const row of [...people, ...savedNames.map(name => ({ name }))]) {
    const name = String(row.name || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleUpperCase('en-IN');
    if (!key) continue;
    const person = byName.get(key) || { name, phones: [] };
    const phone = String(row.phone || '').trim();
    if (phone && !person.phones.includes(phone)) person.phones.push(phone);
    byName.set(key, person);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name, 'en-IN'));
};
