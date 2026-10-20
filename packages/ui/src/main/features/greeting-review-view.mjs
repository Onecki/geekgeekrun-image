export function reviewPresentation(kind) {
  if (kind === 'image-confirm') return {
    reason: '发图二次确认失败，请人工核对',
    detail: '程序未能在服务器历史记录中确认刚发送的图片。请打开当前聊天，核对图片的发送状态。',
    question: '这张图片现在是什么状态？',
    options: [
      ['image-sent', '图片已发送成功', '不重发图片，仅补发文字后继续投递'],
      ['retry', '聊天中没有这张图片', '重新先发图片，再发文字，随后继续投递'],
      ['pause', '图片转圈或显示发送失败', '保持暂停，先处理图片发送异常']
    ]
  }
  if (kind !== 'reconcile') throw new Error('未知的人工核对类型')
  return {
    reason: '对账不确定，请人工核对',
    detail: '程序无法确认上次图文是否已发送。请打开当前聊天，核对上次的发送结果。',
    question: '上次的图片和文字发送到哪一步？',
    options: [
      ['complete', '图片和文字都已发送', '标记完成，继续下一个职位'],
      ['image-sent', '只有图片已发送', '仅补发文字，成功后继续投递'],
      ['retry', '图片和文字都未发送', '重新先发图片，再发文字，随后继续投递']
    ]
  }
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export function reviewHtml(kind, target) {
  const view = reviewPresentation(kind)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>牛人快跑 · 人工核对</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f2f8f7;color:#172333;font:14px 'Microsoft YaHei','Segoe UI',sans-serif}main{margin:20px;background:#fff;border:1px solid #e4edeb;border-radius:12px;padding:26px;box-shadow:0 6px 24px #163c3510}h1{font-size:21px;margin:0 0 20px;line-height:1.6;display:flex;align-items:center;gap:12px}.warning{border-radius:50%;background:#ed9700;color:white;min-width:36px;height:36px;text-align:center;font:700 26px/36px sans-serif}.notice{border:1px solid #eab45c;border-radius:8px;background:#fff9eb;padding:16px 18px}.notice strong{color:#8b4a06;font-size:18px}.notice p{margin:9px 0 0;line-height:1.8;color:#4b5563}.target{font-size:12px;color:#64748b;margin:12px 0 0;overflow-wrap:anywhere}h2{font-size:16px;margin:20px 0 13px}a{color:inherit;text-decoration:none}.option{display:flex;align-items:center;gap:16px;border:1px solid #16a3a5;border-radius:8px;padding:15px 17px;margin:12px 0;min-height:82px;transition:background .12s}.option:hover,.option:focus-visible{background:#ecfafa;outline:3px solid #13a2a52b;outline-offset:2px}.badge{border-radius:50%;background:#dff4f1;color:#008489;font:700 21px/38px sans-serif;min-width:38px;text-align:center}.option strong{display:block;font-size:18px;margin-bottom:5px}.option small{display:block;color:#6b7788;font-size:13px;line-height:1.6}.arrow{margin-left:auto;color:#667888;font-size:25px}.pause{border-color:#e5a437;background:#fffbf2}.pause .badge{color:#a35f00;background:#fff0d2}footer{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #e4eaf0;margin-top:22px;padding-top:17px;color:#7a8796;font-size:12px}.open{border:1px solid #0b999b;border-radius:6px;color:#008589;padding:10px 16px;font-size:14px}.open:hover{background:#eefbfa}a:focus-visible{outline:3px solid #0b999b;outline-offset:3px}
  </style></head><body><main><h1><span class="warning">!</span>任务已停止，需要您手动人工核对</h1><div class="notice"><strong>${view.reason}</strong><p>${view.detail}</p></div><p class="target">当前核对对象：${escape(target)}</p><h2>${view.question}</h2>${view.options.map(([action, label, description], index) => `<a class="option ${action === 'pause' ? 'pause' : ''}" href="https://greeting-review.invalid/${action}" role="button"><span class="badge">${'ABC'[index]}</span><span><strong>${label}</strong><small>${description}</small></span><span class="arrow">›</span></a>`).join('')}<footer><span>关闭或暂不处理将保持停止</span><a class="open" href="https://greeting-review.invalid/open" role="button">打开当前聊天</a></footer></main></body></html>`
}
