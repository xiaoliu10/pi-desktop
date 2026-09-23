/**
 * Pure helpers for the settings replica (U05): nav search, row filtering and
 * page titles. Framework-free for preview tests.
 */

import type { SettingsNavSection, SettingsSectionData, SettingRowData } from '../contracts';

export function filterNavSections(
  sections: SettingsNavSection[],
  query: string,
): SettingsNavSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.label.toLowerCase().includes(q)) }))
    .filter((s) => s.items.length > 0);
}

export function filterRows(sections: SettingsSectionData[], query: string): SettingsSectionData[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((s) => ({
      ...s,
      rows: s.rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q),
      ),
    }))
    .filter((s) => s.rows.length > 0);
}

/** Validate the demo provider form; returns field-level error keys. */
export function validateProviderForm(input: { name: string; modelLine: string }): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('name');
  if (!input.modelLine.trim()) errors.push('model');
  return errors;
}

export function rowControlValue(row: SettingRowData): string | number | boolean {
  switch (row.control.kind) {
    case 'select':
      return row.control.value;
    case 'segmented':
      return row.control.value;
    case 'slider':
      return row.control.value;
    case 'toggle':
      return row.control.value;
    default:
      return '';
  }
}
