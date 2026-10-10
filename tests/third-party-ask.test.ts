import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeableQuestions, detectThirdPartyAsk, planAnswer } from '../src/main/pi/third-party-ask';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-ask-')); roots.push(dir); return dir; }
function json(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
const question = { header: 'Choice', question: 'Choose?', multiSelect: false, options: [{ label: 'Alpha', description: 'A' }, { label: 'Beta', description: 'B' }] };

describe('detectThirdPartyAsk', () => {
  it.each(['npm:rpiv-ask', 'npm:ask_user_question', 'npm:ask.user.question', { source: 'npm:@juicesharp/rpiv-ask-user-question' }])('detects registered package %j', source => {
    const dir = root(); json(path.join(dir, 'settings.json'), { packages: [source] });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: true, source: typeof source === 'string' ? source : source.source });
  });
  it('detects an extension directory but not an extension-named file', () => {
    const dir = root(); fs.mkdirSync(path.join(dir, 'extensions'));
    fs.writeFileSync(path.join(dir, 'extensions', 'ask-user-question.ts'), '');
    expect(detectThirdPartyAsk(dir).detected).toBe(false);
    fs.mkdirSync(path.join(dir, 'extensions', 'rpiv-ask-user-question'));
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: true, source: 'rpiv-ask-user-question' });
  });
  it.each(['ask-user-question', '@juicesharp/rpiv-ask-user-question'])('detects autoload package %s without settings.packages', name => {
    const dir = root(); json(path.join(dir, 'settings.json'), {});
    json(path.join(dir, 'npm/node_modules', name, 'package.json'), { name, pi: { extensions: ['./index.ts'] } });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: true, source: name });
  });
  it('matches directory aliases as well as package names', () => {
    const dir = root(); json(path.join(dir, 'npm/node_modules/ask-user-question/package.json'), { name: 'alias', pi: { extensions: [] } });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: true, source: 'alias' });
  });
  it('excludes desktop packages in all three locations', () => {
    const dir = root(); json(path.join(dir, 'settings.json'), { packages: ['npm:desktop-ask-user-question', { source: 'desktop-rpiv-ask' }] });
    fs.mkdirSync(path.join(dir, 'extensions/desktop-ask-user-question'), { recursive: true });
    json(path.join(dir, 'npm/node_modules/desktop-rpiv-ask/package.json'), { name: 'desktop-rpiv-ask', pi: { extensions: ['index.ts'] } });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: false });
  });
  it('ignores missing, malformed, non-extension and unrelated packages', () => {
    const dir = root(); expect(detectThirdPartyAsk(dir)).toEqual({ detected: false });
    json(path.join(dir, 'settings.json'), { packages: { source: 'ask-user-question' } });
    json(path.join(dir, 'npm/node_modules/ask-user-question/package.json'), { name: 'ask-user-question' });
    json(path.join(dir, 'npm/node_modules/other/package.json'), { name: 'other', pi: { extensions: ['index.ts'] } });
    fs.writeFileSync(path.join(dir, 'npm/node_modules/@broken'), 'not a scope directory');
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: false });
    json(path.join(dir, 'npm/node_modules/@valid/rpiv-ask/package.json'), { name: '@valid/rpiv-ask', pi: { extensions: ['index.ts'] } });
    expect(detectThirdPartyAsk(dir).detected).toBe(true);
  });
  it('survives corrupted settings.json and stale extension symlinks', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    fs.mkdirSync(path.join(dir, 'extensions'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'extensions', 'ask-user-question'));
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: false });
  });
  it('does not false-positive on names that merely contain ask', () => {
    const dir = root();
    json(path.join(dir, 'settings.json'), { packages: ['npm:task-ask-tool'] });
    json(path.join(dir, 'npm/node_modules/task-ask-tool/package.json'), { name: 'task-ask-tool', pi: { extensions: ['index.ts'] } });
    fs.mkdirSync(path.join(dir, 'extensions/task-ask-tool'), { recursive: true });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: false });
  });
  it('detects third-party packages whose desktop mention is not at the name-segment start', () => {
    const dir = root();
    json(path.join(dir, 'settings.json'), { packages: ['npm:my-desktop-ask-user-question'] });
    json(path.join(dir, 'npm/node_modules/my-desktop-rpiv-ask/package.json'), { name: 'my-desktop-rpiv-ask', pi: { extensions: ['index.ts'] } });
    fs.mkdirSync(path.join(dir, 'extensions/my-desktop-ask'), { recursive: true });
    expect(detectThirdPartyAsk(dir)).toEqual({ detected: true, source: 'npm:my-desktop-ask-user-question' });
  });
});

describe('bridgeableQuestions', () => {
  it('normalizes desktop card fields and includes preview within the renderer limit', () => {
    const q = { ...question, header: '  ' + 'h'.repeat(20), question: '  Choose?  ', options: [{ label: '  ' + 'l'.repeat(90), description: 'd'.repeat(400), preview: 'code()' }, question.options[1]] };
    const result = bridgeableQuestions({ questions: [q] })!;
    expect(result[0]).toMatchObject({ header: 'h'.repeat(12), question: 'Choose?', multiSelect: false });
    expect(result[0].options[0].label).toBe('l'.repeat(80));
    expect(result[0].options[0].description).toHaveLength(300);
    expect(result[0].options[0].description.endsWith('\n\n[预览] code()')).toBe(true);
    expect(bridgeableQuestions({ questions: [{ ...question, header: undefined }] })![0].header).toBe('问题 1');
  });
  it('truncates descriptions without preview to 300', () => {
    expect(bridgeableQuestions({ questions: [{ ...question, options: [{ label: 'a', description: 'x'.repeat(400) }, { label: 'b' }] }] })![0].options).toEqual([{ label: 'a', description: 'x'.repeat(300) }, { label: 'b', description: '' }]);
  });
  it('rejects oversized questionnaires rather than truncating questions or indices', () => {
    expect(bridgeableQuestions({ questions: Array(5).fill(question) })).toBeNull();
    expect(bridgeableQuestions({ questions: [{ ...question, options: Array(5).fill(question.options[0]) }] })).toBeNull();
    expect(bridgeableQuestions({ questions: [{ ...question, options: [...question.options, { label: '' }] }] })).toBeNull();
  });
  it.each([undefined, {}, { questions: [] }, { questions: [null] }, { questions: [{ ...question, question: '' }] }, { questions: [{ ...question, options: [] }] }, { questions: [{ ...question, options: [{ label: 'same' }, { label: 'same' }] }] }])('rejects malformed or ambiguous payload %j', args => {
    expect(bridgeableQuestions(args)).toBeNull();
  });
});

describe('planAnswer', () => {
  const questions = [question, { ...question, multiSelect: true }];
  it('maps a single option to its native 1-based index', () => expect(planAnswer(questions, 0, ['Beta'])).toEqual({ kind: 'option', value: '2' }));
  it('maps single custom and empty answers to the sentinel and remembers custom text', () => {
    expect(planAnswer(questions, 0, [' free text '])).toEqual({ kind: 'sentinel', value: '3', custom: ' free text ' });
    expect(planAnswer(questions, 0, [])).toEqual({ kind: 'sentinel', value: '3', custom: '' });
    expect(planAnswer(questions, 0, ['Alpha', 'note'])).toEqual({ kind: 'sentinel', value: '3', custom: 'note' });
  });
  it('maps multiple selected labels to native indices', () => expect(planAnswer(questions, 1, ['Beta', 'Alpha'])).toEqual({ kind: 'multi', value: '2,1' }));
  it('preserves custom multi-select text, including when accompanied by selected labels', () => {
    expect(planAnswer(questions, 1, ['Alpha', ' custom text '])).toEqual({ kind: 'custom', value: ' custom text ' });
  });
  it('preserves deliberate empty commits', () => expect(planAnswer(questions, 1, [])).toEqual({ kind: 'empty', value: '' }));
  it('falls back to empty for out-of-range question indices', () => {
    expect(planAnswer(questions, -1, ['Alpha'])).toEqual({ kind: 'empty', value: '' });
    expect(planAnswer(questions, 99, ['Alpha'])).toEqual({ kind: 'empty', value: '' });
  });
});
