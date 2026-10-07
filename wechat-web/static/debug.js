const $ = (id) => document.getElementById(id);
let loading = false;
// 使用 textContent 展示日志，手机或模型返回的文本不会作为 HTML 执行。
function renderRecords(id, records) {
    const box = $(id);
    const opened = new Set([...box.querySelectorAll('details[open]')].map(item => item.dataset.id));
    box.replaceChildren();
    for (const record of records || []) {
        const item = document.createElement('details');
        item.dataset.id = record.id;
        item.open = opened.has(record.id);
        const title = document.createElement('summary');
        title.textContent = `${record.created} · ${record.kind || 'AI'} · ${record.status} · ${record.id}`;
        const content = document.createElement('pre');
        content.textContent = JSON.stringify(record, null, 2);
        item.append(title, content);
        box.append(item);
    }
    if (!box.children.length) box.textContent = '暂无记录';
}
async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const response = await fetch('/api/debug');
        if (!response.ok) throw new Error('诊断接口请求失败');
        const data = await response.json();
        $('device').textContent = JSON.stringify({connection:data.connection,error:data.error,device:data.device}, null, 2);
        renderRecords('tasks', data.operations);
        renderRecords('jobs', data.ai_jobs);
        $('log').textContent = data.log || '暂无日志';
		// 日志按时间追加，自动滚动到底部展示最近执行记录。
		$('log').scrollTop = $('log').scrollHeight;
        $('log-note').textContent = data.log_error || '服务日志不包含完整手机 agent.log；任务详情显示手机已上报的诊断信息。';
        $('status').textContent = '更新时间：' + new Date().toLocaleTimeString();
    } catch (error) { $('status').textContent = error.message; }
    finally { loading = false; }
}
$('refresh').onclick = refresh;
setInterval(() => { if ($('auto').checked) void refresh(); }, 5000);
void refresh();
