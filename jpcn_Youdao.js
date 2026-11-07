/* global api */
/* 有道日中词典 · Online Dictionary Helper (ODH) 自定义脚本
 * 查询新版网页：中文释义、假名、罗马字、声调、双语例句、日语发音。
 * 整份文件须保持为一个类表达式；不要添加 export、实例化语句或结尾分号。
 */
class jpcn_Youdao {
    constructor() {
        this.base = 'https://www.youdao.com/result';
        this.maxexample = 2; // 每次查询的双语例句数；ODH 设置会覆盖此默认值。
        this.cache = new Map();
    }

    async displayName() {
        return '有道日中词典';
    }

    setOptions(options) {
        if (!options || options.maxexample === undefined || options.maxexample === null
            || String(options.maxexample).trim() === '') return;
        const count = Number(options.maxexample);
        if (Number.isFinite(count) && count >= 0) this.maxexample = Math.floor(count);
    }

    async findTerm(word) {
        if (typeof word !== 'string' || !word.trim()) return [];
        const query = word.trim();
        const url = this.base + '?word=' + encodeURIComponent(query) + '&lang=ja';
        const maxexample = this.maxexample;
        try {
            const html = await this.getPage(url);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return this.parsePage(doc, query, url, maxexample);
        } catch (error) {
            console.warn('[有道日中词典] 查询失败：', error && error.message);
            return [];
        }
    }

    async getPage(url) {
        const cached = this.cache.get(url);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const promise = Promise.resolve().then(() => api.fetch(url)).then(html => {
            if (typeof html !== 'string' || !html.trim()) throw new Error('未取得词条页面');
            return html;
        });
        const entry = { promise, expires: Date.now() + 5 * 60 * 1000 };
        this.cache.set(url, entry);
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
        try {
            return await promise;
        } catch (error) {
            if (this.cache.get(url) === entry) this.cache.delete(url);
            throw error;
        }
    }

    parsePage(doc, query, url, maxexample) {
        const notes = [];
        const seen = new Set();
        // 日语词典专用区域。没有此区域时不把其他语种、搜索建议当成释义。
        for (const container of doc.querySelectorAll('.newjc .page-container')) {
            const expression = this.text(container.querySelector('.word-head .title')) || query;
            // 多读音词还包含未激活的 each-page；全部读取，逐一对应读音和释义。
            for (const page of container.querySelectorAll('.each-page')) {
                const head = page.querySelector('.head-content');
                const pronunciation = this.pronunciation(head);
                const definitions = [];
                for (const sense of page.querySelectorAll('.each-sense')) {
                    const pos = this.text(sense.querySelector('.word-pos'));
                    const glosses = Array.from(sense.querySelectorAll('.sense-con .sense-ja'))
                        .map(node => this.inline(node)).filter(content => content.trim());
                    if (!glosses.length) continue;
                    definitions.push('<div class="youdao-jpcn">'
                        + (pos ? '<div class="youdao-jpcn-pos">' + this.escape(pos) + '</div>' : '')
                        + '<ol class="youdao-jpcn-glosses">'
                        + glosses.map(gloss => '<li>' + gloss + '</li>').join('') + '</ol></div>');
                }
                if (!definitions.length) continue;
                const key = expression + '\n' + pronunciation.reading;
                if (seen.has(key)) continue;
                seen.add(key);
                // 与网页相同：优先用当前词条的假名发音，避免“生”等多读音词串音。
                const audio = head && head.querySelector('.pronounce')
                    ? this.audioUrl(pronunciation.kana || expression) : '';
                notes.push({
                    css: this.renderCSS(),
                    expression: this.escape(expression),
                    reading: this.escape(pronunciation.reading),
                    definitions,
                    audios: audio ? [audio] : []
                });
            }
        }
        if (!notes.length) return [];
        const examples = this.examples(doc, maxexample);
        // 双语例句属于整个查询词；放在最后，避免误认为匹配某一特定读音或义项。
        if (examples) notes[notes.length - 1].definitions.push(examples);
        for (const note of notes) {
            note.definitions[note.definitions.length - 1] += '<div class="youdao-jpcn youdao-jpcn-source">'
                + '来源：<a href="' + this.escape(url) + '" target="_blank" rel="noopener noreferrer">有道词典</a></div>';
        }
        return notes;
    }

    pronunciation(head) {
        if (!head) return { kana: '', reading: '' };
        const spans = Array.from(head.children).filter(node => node.tagName === 'SPAN'
            && !node.classList.contains('divider'));
        const values = spans.map(node => ({ node, value: this.text(node, 'sup') }));
        const kanaPart = values.find(part => /[ぁ-ゖァ-ヺ]/.test(part.value));
        const kana = kanaPart ? kanaPart.value : '';
        const roman = values.filter(part => part !== kanaPart && /[A-Za-zÀ-ž]/.test(part.value))
            .map(part => part.value).join(' ');
        const tone = kanaPart ? this.text(kanaPart.node.querySelector('sup')) : '';
        // 原站用 ⓪①② 表示声调；转成 [0][1][2]，方便复制到卡片。
        const accent = tone ? tone.replace(/[⓪①-⑳]/g, ch => '[' + ch.normalize('NFKC') + ']') : '';
        return { kana, reading: [kana, accent, roman].filter(Boolean).join(' ') };
    }

    examples(doc, maxexample) {
        if (maxexample <= 0) return '';
        const items = [];
        const seen = new Set();
        for (const item of doc.querySelectorAll('.blng_sents_part .trans-container > ul > li')) {
            const jp = item.querySelector('.sen-eng');
            const zh = item.querySelector('.sen-ch');
            const jpText = this.text(jp);
            const zhText = this.text(zh);
            if (!jpText || !zhText) continue;
            const key = jpText + '\n' + zhText;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push('<li><div lang="ja">' + this.inline(jp) + '</div>'
                + '<div class="youdao-jpcn-zh">' + this.inline(zh) + '</div></li>');
            if (items.length >= maxexample) break;
        }
        return items.length ? '<div class="youdao-jpcn"><div class="youdao-jpcn-label">双语例句（按查询词）</div>'
            + '<ol class="youdao-jpcn-examples">' + items.join('') + '</ol></div>' : '';
    }

    audioUrl(kana) {
        return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(kana) + '&le=jap';
    }

    text(node, extraSelector) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        const excluded = 'script, style, button, svg, iframe, object, .word-book_operate, .word-operate_comp, .pronounce_comp';
        for (const child of clone.querySelectorAll(excluded + (extraSelector ? ', ' + extraSelector : ''))) child.remove();
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    escape(value) {
        return String(value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    inline(node) {
        // 重建安全的文字与行内标记；不执行页面脚本，也不复制事件、链接和样式。
        if (!node) return '';
        if (node.nodeType === 3) return this.escape(node.textContent);
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'button', 'svg', 'iframe', 'object', 'audio', 'video'].includes(tag)) return '';
        if (tag === 'br') return '<br>';
        const content = Array.from(node.childNodes).map(child => this.inline(child)).join('');
        return ['b', 'strong', 'em', 'i', 'ruby', 'rt', 'rp', 'sup', 'sub'].includes(tag)
            ? '<' + tag + '>' + content + '</' + tag + '>' : content;
    }

    renderCSS() {
        return `<style>
            .youdao-jpcn { line-height: 1.8; overflow-wrap: anywhere; }
            .youdao-jpcn .youdao-jpcn-pos { font-size: .86em; opacity: .75; margin-bottom: .2em; }
            .youdao-jpcn .youdao-jpcn-glosses { margin: 0; padding-left: 1.5em; }
            .youdao-jpcn .youdao-jpcn-label { font-size: .88em; font-weight: 600; margin: .6em 0 .3em; }
            .youdao-jpcn .youdao-jpcn-examples { margin: 0; padding-left: 1.5em; }
            .youdao-jpcn .youdao-jpcn-examples > li { margin: .6em 0; padding-left: .2em; }
            .youdao-jpcn .youdao-jpcn-zh { opacity: .78; font-size: .94em; }
            .youdao-jpcn rt { font-size: .6em; }
            .youdao-jpcn-source { margin-top: .7em; font-size: .78em; opacity: .65; }
        </style>`;
    }
}
