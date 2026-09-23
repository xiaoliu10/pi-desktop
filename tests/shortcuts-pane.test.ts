import { describe, expect, it } from 'vitest';
import { bindingKeys, eventToBinding } from '../src/renderer/pi/ShortcutsPane';
import { DEFAULT_SHORTCUTS, shortcutMatches, validShortcut } from '../src/shared/settings';

describe('bindingKeys', () => {
  it('renders mac symbols on macOS', () => {
    expect(bindingKeys('Mod+Shift+N', true)).toEqual(['⌘', '⇧', 'N']);
    expect(bindingKeys('Mod+B', true)).toEqual(['⌘', 'B']);
    expect(bindingKeys('Mod+Alt+P', true)).toEqual(['⌘', '⌥', 'P']);
  });

  it('renders word modifiers elsewhere', () => {
    expect(bindingKeys('Mod+Shift+N', false)).toEqual(['Ctrl', 'Shift', 'N']);
    expect(bindingKeys('Mod+,', false)).toEqual(['Ctrl', ',']);
  });

  it('maps special key labels', () => {
    expect(bindingKeys('Mod+ArrowUp', true)).toEqual(['⌘', '↑']);
    expect(bindingKeys('Mod+F5', true)).toEqual(['⌘', 'F5']);
  });
});

describe('eventToBinding', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it('builds Mod+Shift bindings from keystrokes', () => {
    expect(eventToBinding({ ...base, key: 'n', metaKey: true, shiftKey: true })).toBe('Mod+Shift+N');
    expect(eventToBinding({ ...base, key: 'k', ctrlKey: true })).toBe('Mod+K');
    expect(eventToBinding({ ...base, key: ',', metaKey: true })).toBe('Mod+,');
  });

  it('rejects modifier-less keys and unsupported keys', () => {
    expect(eventToBinding({ ...base, key: 'a' })).toBeNull();
    expect(eventToBinding({ ...base, key: 'Meta', metaKey: true })).toBeNull();
    expect(eventToBinding({ ...base, key: 'ArrowUp', metaKey: true })).toBeNull();
  });
});

describe('round-trip with the runtime matcher', () => {
  it('captured bindings match the same keystrokes via shortcutMatches', () => {
    const event = { key: 'b', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    const binding = eventToBinding(event);
    expect(binding).toBe('Mod+B');
    expect(shortcutMatches(event, binding!)).toBe(true);
    expect(shortcutMatches({ ...event, shiftKey: true }, binding!)).toBe(false);
  });

  it('every default binding survives the formatter', () => {
    for (const binding of Object.values(DEFAULT_SHORTCUTS)) {
      expect(validShortcut(binding)).toBe(true);
      const [head, ...rest] = bindingKeys(binding, true);
      expect(head).toBe('⌘');
      expect(rest.length).toBeGreaterThan(0);
    }
  });
});
