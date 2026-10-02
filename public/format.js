// 메시지 본문 서식: *굵게* _기울임_ ~취소선~ `코드` ```코드 블록``` 링크, <@id> 멘션.
// parseBody는 DOM 없이 토큰만 만들어서 Node 테스트에서도 쓸 수 있다.

const INLINE = new RegExp(
  [
    /<@([0-9a-f-]{36}|all)>/.source,
    /(https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?])/.source,
    /(?<![\p{L}\p{N}*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}*])/.source,
    /(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/.source,
    /(?<![\p{L}\p{N}~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\p{L}\p{N}~])/.source,
  ].join('|'),
  'gu',
);

function parseInline(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    const [whole, mention, url, bold, italic, strike] = match;
    if (mention) out.push({ type: 'mention', id: mention });
    else if (url) out.push({ type: 'link', href: url });
    else if (bold) out.push({ type: 'bold', children: parseInline(bold) });
    else if (italic) out.push({ type: 'italic', children: parseInline(italic) });
    else if (strike) out.push({ type: 'strike', children: parseInline(strike) });
    else out.push({ type: 'text', text: whole });
    last = match.index + whole.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export function parseBody(body = '') {
  const out = [];
  const blocks = body.split(/```/);
  blocks.forEach((part, i) => {
    // 홀수 번째 조각은 ``` 사이(코드 블록). 닫히지 않은 마지막 ```는 글자 그대로 둔다.
    if (i % 2 === 1 && i < blocks.length - 1) {
      out.push({ type: 'codeblock', text: part.replace(/^\n/, '').replace(/\n$/, '') });
      return;
    }
    const text = i % 2 === 1 ? `\`\`\`${part}` : part;
    const pieces = text.split(/`([^`\n]+)`/);
    pieces.forEach((piece, j) => {
      if (j % 2 === 1) out.push({ type: 'code', text: piece });
      else if (piece) out.push(...parseInline(piece));
    });
  });
  return out;
}

function toNodes(tokens, mentions, meId) {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text':
        return document.createTextNode(token.text);
      case 'mention': {
        const el = document.createElement('span');
        el.className = `mention${token.id === meId || token.id === 'all' ? ' me' : ''}`;
        el.textContent = `@${token.id === 'all' ? 'all' : (mentions?.[token.id] ?? '알 수 없음')}`;
        return el;
      }
      case 'link': {
        const el = document.createElement('a');
        el.href = token.href;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.textContent = token.href;
        return el;
      }
      case 'code':
      case 'codeblock': {
        const el = document.createElement(token.type === 'code' ? 'code' : 'pre');
        el.textContent = token.text;
        return el;
      }
      default: {
        const el = document.createElement({ bold: 'strong', italic: 'em', strike: 's' }[token.type]);
        el.append(...toNodes(token.children, mentions, meId));
        return el;
      }
    }
  });
}

export function renderBody(body, mentions, meId) {
  const fragment = document.createDocumentFragment();
  fragment.append(...toNodes(parseBody(body), mentions, meId));
  return fragment;
}

/** 저장된 본문의 <@id>를 사람이 고칠 수 있는 "@이름"으로 바꾼다. */
export function toEditable(body = '', mentions = {}) {
  return body.replace(/<@([0-9a-f-]{36}|all)>/g, (whole, id) => {
    if (id === 'all') return '@all';
    return mentions[id] ? `@${mentions[id]}` : whole;
  });
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 입력창의 "@이름"을 자동 완성으로 고른 사람에 한해 <@id> 토큰으로 바꾼다. */
export function fromEditable(text, mentionMap) {
  let result = text;
  const names = [...mentionMap.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu');
    result = result.replace(pattern, (_, lead) => `${lead}<@${mentionMap.get(name)}>`);
  }
  return result;
}
