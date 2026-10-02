import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromEditable, parseBody, toEditable } from '../public/format.js';

const ID = '11111111-2222-3333-4444-555555555555';

test('서식을 토큰으로 나눈다', () => {
  assert.deepEqual(parseBody('*굵게* _기울임_ ~줄~'), [
    { type: 'bold', children: [{ type: 'text', text: '굵게' }] },
    { type: 'text', text: ' ' },
    { type: 'italic', children: [{ type: 'text', text: '기울임' }] },
    { type: 'text', text: ' ' },
    { type: 'strike', children: [{ type: 'text', text: '줄' }] },
  ]);
  // 단어 안의 기호나 공백으로 둘러싼 별표는 서식이 아니다.
  assert.deepEqual(parseBody('snake_case_name 2 * 3 * 4'), [{ type: 'text', text: 'snake_case_name 2 * 3 * 4' }]);
});

test('코드 안은 서식을 적용하지 않는다', () => {
  assert.deepEqual(parseBody('`*a*` 와 ```\n*b*\n```'), [
    { type: 'code', text: '*a*' },
    { type: 'text', text: ' 와 ' },
    { type: 'codeblock', text: '*b*' },
  ]);
  assert.deepEqual(parseBody('``` 안 닫힘'), [{ type: 'text', text: '``` 안 닫힘' }]);
});

test('링크와 멘션', () => {
  assert.deepEqual(parseBody(`봐 https://example.com/a?b=1. <@${ID}> <@all>`), [
    { type: 'text', text: '봐 ' },
    { type: 'link', href: 'https://example.com/a?b=1' },
    { type: 'text', text: '. ' },
    { type: 'mention', id: ID },
    { type: 'text', text: ' ' },
    { type: 'mention', id: 'all' },
  ]);
  // javascript: 같은 링크는 만들지 않는다.
  assert.deepEqual(parseBody('javascript:alert(1)'), [{ type: 'text', text: 'javascript:alert(1)' }]);
});

test('@이름 ↔ 멘션 토큰', () => {
  const map = new Map([['김 철수', ID], ['all', 'all']]);
  assert.equal(fromEditable('@김 철수 안녕 @all, @allison', map), `<@${ID}> 안녕 <@all>, @allison`);
  assert.equal(fromEditable('메일 a@all 은 그대로', map), '메일 a@all 은 그대로');
  assert.equal(toEditable(`<@${ID}> <@all>`, { [ID]: '김 철수' }), '@김 철수 @all');
});
