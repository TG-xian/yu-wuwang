/* 九爻印生成器：std / opt / plain 三种密度
   - std : ≥32px（完整九爻 + 外框 + 三层金）
   - opt : ≤24px（去框、粗线、宽断口、单层亮金）
   - plain: 无外框，仅爻线（水印/底纹用）
   - 爻序（上→下）：乾3实 / 震(断断实) / 坤3断 —— 豫+无妄共用「震」的叠合
*/
(function () {
  const G = '#C9A227', GL = '#E8C766', GD = '#8A6D1F', GL2 = '#F5D882';
  const SEQ = [1, 1, 1, 0, 0, 1, 0, 0, 0];

  function build(variant) {
    const opt = variant === 'opt';
    const plain = variant === 'plain';
    const o = opt
      ? { lw: 5.8, gap: 2.9, x0: 19, Wd: 58, GAP: 17, y0: 11, frame: 1.6,
          cols: [GL2, GL2, GL2, GL2, GL2, GL2, G, G, G] }
      : { lw: 4.4, gap: 4.0, x0: 20, Wd: 56, GAP: 10, y0: 12.2, frame: 3,
          cols: [G, G, G, GL, GL, GL, GD, GD, GD] };

    let h = '';
    if (!plain) {
      const f = opt ? { x: 3, w: 90 } : { x: 7.5, w: 81 };
      h += `<rect x="${f.x}" y="${f.x}" width="${f.w}" height="${f.w}" fill="none" stroke="${G}" stroke-width="${o.frame}"/>`;
    }
    for (let i = 0; i < 9; i++) {
      const y = o.y0 + i * (o.lw + o.gap);
      const c = o.cols[i];
      if (SEQ[i] === 1) {
        h += `<rect x="${o.x0}" y="${y}" width="${o.Wd}" height="${o.lw}" rx="0.9" fill="${c}"/>`;
      } else {
        const seg = (o.Wd - o.GAP) / 2;
        h += `<rect x="${o.x0}" y="${y}" width="${seg}" height="${o.lw}" rx="0.9" fill="${c}"/>`
           + `<rect x="${o.x0 + seg + o.GAP}" y="${y}" width="${seg}" height="${o.lw}" rx="0.9" fill="${c}"/>`;
      }
    }
    return h;
  }

  function paint(root) {
    (root || document).querySelectorAll('svg[data-logo]').forEach((el) => {
      el.innerHTML = build(el.dataset.logo);
    });
  }

  window.YW = window.YW || {};
  window.YW.logo = { build, paint };
  paint(document);
})();
