const { runStoryTransportProbe } = require('./story-transport-probe');

Page({
  data: { running: false, status: '同一账号分别在电脑、手机 Wi-Fi 和手机移动网络测量。', rows: [], report: '' },
  onUnload() { this.stopped = true; },
  async run() {
    if (this.data.running) return;
    this.stopped = false;
    this.setData({ running: true, rows: [], report: '', status: '正在交替测量 6 次，只读取数据，请留在本页。' });
    try {
      const system = wx.getSystemInfoSync();
      const network = await new Promise(resolve => wx.getNetworkType({
        success: r => resolve(r.networkType), fail: () => resolve('unknown'),
      }));
      const report = { schemaVersion: 1, platform: system.platform, system: system.system,
        SDKVersion: system.SDKVersion, wechatVersion: system.version, network, samples: [] };
      const rows = [];
      report.samples = await runStoryTransportProbe(input => wx.cloud.callFunction(input), {
        cancelled: () => this.stopped,
        onSample: sample => {
          rows.push({ label: sample.action === 'state' ? '完整状态' : '小响应', ms: sample.durationMs,
            kb: (sample.utf8Bytes / 1024).toFixed(1) });
          if (!this.stopped) this.setData({ rows });
        },
      });
      if (!this.stopped) this.setData({ report: JSON.stringify(report),
        status: report.samples.length === 6 && report.samples.every(s => s.ok)
          ? '测量完成。可复制结果发回当前性能任务。' : '测量未完成，已停止。结果保留失败阶段。' });
    } catch {
      if (!this.stopped) this.setData({ status: '测量未完成，请检查网络后重试。' });
    } finally {
      if (!this.stopped) this.setData({ running: false });
    }
  },
  copy() { if (this.data.report) wx.setClipboardData({ data: this.data.report }); },
});
