/**
 * 敏感财务页面防截图/防外传水印组件
 * 叠加当前操作者身份标识 + 日期，用于追溯截图外传来源
 */
Component({
    properties: {
        identity: {
            type: String,
            value: ''
        }
    },
    data: {
        cells: new Array(48).fill(0),
        fullText: ''
    },
    lifetimes: {
        attached() {
            this.updateText();
        }
    },
    observers: {
        identity() {
            this.updateText();
        }
    },
    methods: {
        updateText() {
            const identity = this.properties.identity || '';
            if (!identity) {
                this.setData({ fullText: '' });
                return;
            }
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            this.setData({ fullText: `${identity} · ${dateStr}` });
        }
    }
});
