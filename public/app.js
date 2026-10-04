(() => {
  'use strict';
  const socket = typeof io !== 'undefined' ? io() : null;
  const meal = document.querySelector('[data-watch-meal]');
  if (socket && meal) {
    const id = Number(meal.dataset.watchMeal);
    socket.emit('meal:watch', id);
    socket.on('meal:update', data => {
      if (Number(data.mealId) !== id) return;
      document.querySelectorAll('[data-stat="answered"]').forEach(n => n.textContent = data.stats.answered);
      document.querySelectorAll('[data-stat="total"]').forEach(n => n.textContent = data.stats.total);
      document.querySelectorAll('[data-stat="missing"]').forEach(n => n.textContent = data.stats.missing);
      document.querySelectorAll('[data-stat="distributed"]').forEach(n => n.textContent = data.stats.distributed);
      const body = document.querySelector('[data-live-aggregate]');
      if (body) {
        body.innerHTML = data.aggregate.map(r => `<tr><td>${esc(r.category)}</td><td>${esc(r.item)}</td><td><strong>× ${r.qty}</strong></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Aucune commande.</td></tr>';
      }
      const supplier = document.querySelector('#supplier-text');
      if (supplier) supplier.textContent = formatAggregate(data.aggregate);
      const missing = document.querySelector('[data-live-missing]');
      if (missing) missing.innerHTML = data.missingPeople.length ? data.missingPeople.map(name => `<span>${esc(name)}</span>`).join('') : '<span class="badge ok">Tout le monde a répondu</span>';
      const distribution = document.querySelector('[data-live-distribution]');
      if (distribution) distribution.innerHTML = data.orders.map(o => {
        const choices = o.choices.map(x => esc(x.item)).join(' · ') || '—';
        const done = !!o.distributed_at;
        return `<tr class="distribution-row ${done?'done':''}"><td><strong>${esc(o.name)}</strong></td><td>${choices}</td><td><span class="badge ${done?'ok':''}">${done?'remis':'à remettre'}</span></td><td><form method="post" action="/admin/orders/${o.order_id}/distributed"><button class="btn ${done?'light':'success'}">${done?'Annuler':'Remis'}</button></form></td></tr>`;
      }).join('');
    });
  }
  function formatAggregate(rows){
    const grouped = new Map();
    rows.forEach(r => { if(!grouped.has(r.category)) grouped.set(r.category, []); grouped.get(r.category).push(`${r.item} × ${r.qty}`); });
    return [...grouped.entries()].map(([cat,items]) => `${cat.toUpperCase()}\n${items.join('\n')}`).join('\n\n') || 'Aucune commande.';
  }
  function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const target = document.querySelector(btn.dataset.copy);
    if (!target) return;
    await navigator.clipboard.writeText(target.innerText.trim());
    const old=btn.textContent; btn.textContent='Copié'; setTimeout(()=>btn.textContent=old,1200);
  }));
  document.querySelectorAll('[data-check-all]').forEach(btn => btn.addEventListener('click', () => {
    const form=document.querySelector(btn.dataset.checkAll); if(!form)return;
    form.querySelectorAll('input[type="checkbox"]').forEach(i=>i.checked=true);
  }));
})();
