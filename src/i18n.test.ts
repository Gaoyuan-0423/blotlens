import { describe, it, expect } from 'vitest';
import { translate } from './i18n';
import english from './locales/en.json';
describe('bilingual presentation', () => {
  it('preserves Chinese and substitutes all translation placeholders', () => {
    for (const [source, target] of Object.entries(english)) {
      expect(target.trim()).not.toBe('');
      expect(target).not.toMatch(/\p{Script=Han}/u);
      expect((source.match(/\{\d+\}/g) ?? []).sort()).toEqual((target.match(/\{\d+\}/g) ?? []).sort());
      expect(translate(source, 'zh')).toBe(source);
      expect(translate(source, 'en')).toBe(target);
    }
    expect(translate('整体移动 {0} 个取样框', 'en', [3])).toBe('Move 3 ROIs together');
  });
  it('translates dynamic server errors without losing endpoint/model context', () => {
    const context = 'https://api.deepseek.com/v1 · deepseek-flash';
    const error = `服务商返回 HTTP 403（${context}）：访问被拒绝，不能仅据此认定 Key 错误。请检查账户权限、IP 白名单或地区限制；线上请求从本站服务器发出，与本机出口不同。`;
    expect(translate(error, 'en')).toContain(context);
    expect(translate(error, 'en')).toContain('HTTP 403');
    expect(translate(error, 'en')).not.toMatch(/\p{Script=Han}/u);
    expect(translate('无法使用模型结果：泳道 ID 重复。可重试或人工框选', 'en')).toBe('Cannot use model result: Duplicate lane ID. Retry or use manual ROIs');
  });
  it('leaves unrecognized user and model text intact', () => {
    expect(translate('KOA / 自定义实验组', 'en')).toBe('KOA / 自定义实验组');
  });
});
