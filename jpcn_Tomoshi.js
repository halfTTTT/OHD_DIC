/* global api */
/* Tomoshi 日中词典 · ODH 自定义脚本
 * 查询：中文释义、假名、重音、双语例句、词语发音。
 * 本文件保持为一个类表达式，请勿添加 export、实例化代码或结尾分号。
 */
class jpcn_Tomoshi {
    constructor() {
        this.base = 'https://dict.tomoshi.app';
        this.audioBase = 'https://api.tomoshi.app';
        this.maxexample = 2; // 每条释义最多显示的例句数；也读取 ODH 的同名设置。
        this.maxentries = 3; // 同一写法最多返回的词条数。
        this.cache = new Map();
    }

    async displayName() {
        return 'Tomoshi 日中词典';
    }

    setOptions(options) {
        if (!options || options.maxexample === undefined || options.maxexample === null) return;
        const count = Number(options.maxexample);
        if (Number.isFinite(count) && count >= 0) this.maxexample = Math.floor(count);
    }

    async findTerm(word) {
        if (typeof word !== 'string' || !word.trim()) return [];
        const query = word.trim().normalize('NFKC');
        const maxexample = this.maxexample;
        let urls = [];
        try {
            urls = await this.findEntryUrls(query);
        } catch (error) {
            // 索引暂时不可用时，仍尝试网站的词条地址及同形词选择页。
            console.warn('[Tomoshi] 索引查询失败，尝试直接查词：', error.message);
        }
        if (!urls.length) urls = [this.base + '/w/' + encodeURIComponent(query)];
        const groups = await Promise.all(urls.map(url => this.readEntry(url, maxexample, 0, query)));
        const seen = new Set();
        return [].concat(...groups).filter(note => {
            const key = note.expression + '\n' + note.reading;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, this.maxentries);
    }

    async findEntryUrls(query) {
        const manifest = await this.getJson(this.base + '/_/sug/manifest.json');
        if (!manifest || typeof manifest.ver !== 'string' || !/^[\w.-]+$/.test(manifest.ver)) return [];
        const root = this.base + '/_/sug/' + manifest.ver + '/zh-Hans/';
        const chars = Array.from(query);
        const shard = chars[0].codePointAt(0).toString(16);
        let rows = await this.getJson(root + 'j/' + shard + '.json', true);
        let matches = this.exactRows(rows, query);
        if (!matches.length) {
            // 网站将较少见的词条放在 j2 中；部分首字还按第二字拆分。
            const split = await this.getJson(root + 'j2/index.json', true);
            const key = Array.isArray(split) && split.includes(shard)
                ? shard + '-' + (chars[1] ? chars[1].codePointAt(0).toString(16) : '')
                : shard;
            rows = await this.getJson(root + 'j2/' + key + '.json', true);
            matches = this.exactRows(rows, query);
        }
        // 索引第五列的第 64 位标记常用词；保持同一档内的网站原有顺序。
        matches.sort((a, b) => Number(Boolean((b[4] || 0) & 64)) - Number(Boolean((a[4] || 0) & 64)));
        const urls = matches.map(row => {
            const slug = row[1] === 0 ? row[0] : row[1];
            return typeof slug === 'string' ? this.base + '/w/' + encodeURIComponent(slug) : '';
        }).filter(Boolean);
        return Array.from(new Set(urls)).slice(0, this.maxentries);
    }

    exactRows(rows, query) {
        return Array.isArray(rows) ? rows.filter(row => Array.isArray(row) && row[0] === query) : [];
    }

    async getJson(url, optional) {
        try {
            return JSON.parse(await this.getText(url));
        } catch (error) {
            if (optional) return [];
            throw error;
        }
    }

    async getText(url) {
        const cached = this.cache.get(url);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const promise = Promise.resolve().then(() => api.fetch(url)).then(data => {
            if (typeof data !== 'string' || !data.trim()) throw new Error('网页不可用：' + url);
            return data;
        });
        const entry = { promise, expires: Date.now() + 10 * 60 * 1000 };
        this.cache.set(url, entry);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
        try {
            return await promise;
        } catch (error) {
            if (this.cache.get(url) === entry) this.cache.delete(url);
            throw error;
        }
    }

    async readEntry(url, maxexample, depth, query) {
        try {
            const html = await this.getText(url);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const article = doc.querySelector('article.entry-card');
            if (article) {
                const canonical = doc.querySelector('link[rel="canonical"]');
                const source = this.wordUrl(canonical && canonical.getAttribute('href')) || url;
                const note = this.parseEntry(article, doc, source, maxexample, query);
                return note ? [note] : [];
            }
            // 例如 /w/生 会返回同形词列表；只跟随本站词条链接，且最多一层。
            if (depth > 0) return [];
            const links = Array.from(doc.querySelectorAll('main .wl-list a')).map(a =>
                this.wordUrl(a.getAttribute('href') || a.getAttribute('data-href'))
            ).filter(Boolean);
            const urls = Array.from(new Set(links)).slice(0, this.maxentries);
            const groups = await Promise.all(urls.map(link => this.readEntry(link, maxexample, depth + 1, query)));
            return [].concat(...groups);
        } catch (error) {
            console.warn('[Tomoshi] 词条读取失败：', error.message);
            return [];
        }
    }

    wordUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(value, this.base);
            return url.origin === this.base && url.pathname.startsWith('/w/')
                && url.pathname.length > 3 && !url.search ? url.origin + url.pathname : '';
        } catch (error) {
            return '';
        }
    }

    parseEntry(article, doc, source, maxexample, query) {
        const header = article.querySelector('.entry-header');
        if (!header) return null;
        const forms = Array.from(header.querySelectorAll('.word .kanji')).map(node => this.text(node));
        const expression = forms.includes(query) ? query : forms[0];
        if (!expression) return null;
        const button = header.querySelector('button[data-tts-s]');
        let kana = this.text(header.querySelector('.word .kana'));
        // 纯假名词头通常不重复显示 .kana；从发音标记取读音并转为平假名。
        if (!kana && button) kana = (button.getAttribute('data-tts-r') || '').replace(/[ァ-ヶ]/g,
            ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
        if (!kana && /^[ぁ-ゖァ-ヶー]+$/.test(expression)) kana = expression;
        const pitch = this.text(header.querySelector('.pa .pl')).replace(/\](?=\S)/g, '] ');
        const reading = [kana, pitch].filter(Boolean).join('　');
        const definitions = [];
        let hasExample = false;
        for (const item of article.querySelectorAll('.def-item')) {
            const gloss = this.text(item.querySelector('.glosses'));
            if (!gloss) continue; // 不混入页面后面的日语释义、活用表或推荐内容。
            const pos = this.text(item.querySelector('.pos'));
            let content = '<div class="tomoshi-odh">';
            if (pos) content += '<span class="tomoshi-odh-pos">' + this.escape(pos) + '</span>';
            content += '<span class="tomoshi-odh-gloss">' + this.escape(gloss) + '</span>';
            const examples = Array.from(item.querySelectorAll('.example')).slice(0, maxexample);
            for (const example of examples) {
                const jp = example.querySelector('.example-jp');
                if (!jp) continue;
                hasExample = true;
                const zh = this.text(example.querySelector('.example-zh'));
                content += '<div class="tomoshi-odh-example"><div lang="ja">' + this.inline(jp) + '</div>';
                if (zh) content += '<div class="tomoshi-odh-zh">' + this.escape(zh) + '</div>';
                content += '</div>';
            }
            definitions.push(content + '</div>');
        }
        if (!definitions.length) return null;
        definitions[definitions.length - 1] += '<div class="tomoshi-odh tomoshi-odh-source">来源：'
            + '<a href="' + this.escape(source) + '" target="_blank" rel="noopener noreferrer">Tomoshi</a>'
            + (hasExample ? ' · 例句：Tatoeba' : '') + '</div>';
        // 与原站一致：非常用、非 JLPT 的 noindex 占位页不显示发音。
        const robots = doc.querySelector('meta[name="robots"]');
        const gated = robots && /noindex/i.test(robots.getAttribute('content') || '')
            && !header.querySelector('.meta .jlpt, .meta .common');
        const audio = !gated && this.audioUrl(button);
        return {
            css: this.renderCSS(),
            expression: this.escape(expression),
            reading: this.escape(reading),
            definitions,
            audios: audio ? [audio] : []
        };
    }

    audioUrl(button) {
        if (!button || !button.getAttribute('data-tts-s')) return '';
        const url = new URL('/v1/ja/tts/web', this.audioBase);
        url.searchParams.set('surface', button.getAttribute('data-tts-s'));
        const reading = button.getAttribute('data-tts-r');
        const accent = button.getAttribute('data-tts-a');
        if (reading) url.searchParams.set('reading', reading);
        if (accent) url.searchParams.set('accent', accent); // "0" 也是有效重音。
        return url.href;
    }

    text(node) {
        return node ? node.textContent.trim() : '';
    }

    escape(value) {
        return String(value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    inline(node) {
        // 只重建文字与振假名，不带入原站按钮、事件、脚本和样式。
        if (node.nodeType === 3) return this.escape(node.textContent);
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        if (['button', 'svg', 'script', 'style', 'iframe', 'object'].includes(tag)
            || node.classList.contains('src')) return '';
        const content = Array.from(node.childNodes).map(child => this.inline(child)).join('');
        return ['ruby', 'rt', 'rp', 'rb'].includes(tag) ? '<' + tag + '>' + content + '</' + tag + '>' : content;
    }

    renderCSS() {
        return `<style>
            .tomoshi-odh { line-height: 1.75; overflow-wrap: anywhere; }
            .tomoshi-odh .tomoshi-odh-pos { display: inline-block; margin-right: .5em; padding: 0 .4em; border-radius: 3px; background: rgba(100, 116, 139, .16); font-size: .85em; }
            .tomoshi-odh .tomoshi-odh-gloss { font-weight: 600; }
            .tomoshi-odh .tomoshi-odh-example { margin: .6em 0; padding-left: .75em; border-left: 2px solid #c49255; }
            .tomoshi-odh .tomoshi-odh-zh { opacity: .8; font-size: .94em; }
            .tomoshi-odh ruby { ruby-align: center; }
            .tomoshi-odh rt { font-size: .6em; }
            .tomoshi-odh-source { margin-top: .7em; font-size: .78em; opacity: .7; }
        </style>`;
    }
}
