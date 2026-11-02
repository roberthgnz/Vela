const Affiliates={CLAVE_REF:"to_growth_ref",DIAS_REF:30,resumen:null,init(){this.capturarRef(),this.bindEvents()},capturarRef(){let t=null;try{const i=new URLSearchParams(window.location.search).get("ref"),s=window.location.hash||"",e=s.includes("?")?new URLSearchParams(s.split("?")[1]).get("ref"):null;t=this.limpiar(i||e)}catch{t=null}if(!t)return;try{localStorage.setItem(this.CLAVE_REF,JSON.stringify({codigo:t,ts:Date.now()}))}catch{}const a="to_growth_ref_clic_"+t+"_"+new Date().toISOString().slice(0,10);try{if(localStorage.getItem(a))return;localStorage.setItem(a,"1")}catch{}fetch("/api/afiliados/clic",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({codigo:t})}).catch(()=>{})},limpiar(t){const a=String(t||"").trim().toUpperCase().replace(/[^A-Z0-9-]/g,"");return a.length>=3&&a.length<=40?a:null},refGuardado(){try{const t=localStorage.getItem(this.CLAVE_REF);if(!t)return null;const a=JSON.parse(t);return!a||!a.codigo||Date.now()-(a.ts||0)>this.DIAS_REF*864e5?(localStorage.removeItem(this.CLAVE_REF),null):a.codigo}catch{return null}},async atribuir(){const t=this.refGuardado();if(t)try{const a=await this.llamar("/api/afiliados/atribuir","POST",{codigo:t});a&&(a.ok||a.yaAtribuido)&&localStorage.removeItem(this.CLAVE_REF)}catch{}},async token(){try{const t=typeof getSupabase=="function"?getSupabase():null;if(!t)return null;const{data:{session:a}}=await t.auth.getSession();return a?a.access_token:null}catch{return null}},async llamar(t,a="GET",i){const s=await this.token();if(!s)throw new Error("Inicia sesión.");const e=await fetch(t,{method:a,headers:{"Content-Type":"application/json",Authorization:"Bearer "+s},body:i?JSON.stringify(i):void 0}),n=await e.json().catch(()=>({}));if(!e.ok){const o=new Error(n.error||"Error "+e.status);throw o.status=e.status,o}return n},esc(t){return String(t??"").replace(/[&<>"']/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[a])},eur(t){return Number(t||0).toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})+" €"},getReferralLink(t){return`${window.location.origin}/?ref=${encodeURIComponent(t||this.resumen&&this.resumen.codigo||"")}#pricing`},bindEvents(){document.addEventListener("click",async t=>{if(t.target.closest("#copyAffiliateLinkBtn")){t.preventDefault();const e=this.getReferralLink();try{await navigator.clipboard.writeText(e)}catch{const o=document.getElementById("affiliateLinkInput");o&&(o.select(),document.execCommand&&document.execCommand("copy"))}typeof App<"u"&&App.showToast&&App.showToast("Enlace de afiliado copiado.","success")}const i=t.target.closest("#requestPayoutBtn");if(i){t.preventDefault(),i.disabled=!0;try{const e=await this.llamar("/api/afiliados/cobro","POST",{});typeof App<"u"&&App.showToast&&App.showToast(`Solicitud enviada: ${this.eur(e.total)}. Te escribimos para hacerte el pago.`,"success")}catch(e){typeof App<"u"&&App.showToast&&App.showToast(e.message,"warning")}this.renderDashboardTab()}t.target.closest("#affiliatesReintentar")&&(t.preventDefault(),this.renderDashboardTab())})},async renderDashboardTab(){const t=document.getElementById("affiliatesTabContent");if(!t)return;t.innerHTML='<div class="glass-card" style="padding:22px; display:flex; align-items:center; gap:10px;"><i class="ri-loader-4-line spin" style="color:var(--acento-claro);"></i> <span style="color:var(--text-muted); font-size:14px;">Cargando tu panel de afiliado…</span></div>';let a;try{a=await this.llamar("/api/afiliados/resumen")}catch(n){t.innerHTML=`
                <div class="glass-card" style="padding:26px;">
                    <h3 style="margin-bottom:8px;">Programa de afiliados</h3>
                    <p style="color:var(--text-muted); margin-bottom:14px;">${n.status===401?"Inicia sesión para ver tu enlace y tus comisiones.":this.esc(n.message)}</p>
                    <button type="button" id="affiliatesReintentar" class="btn btn-outline btn-sm"><i class="ri-refresh-line"></i> Reintentar</button>
                </div>`;return}this.resumen=a;const i=this.getReferralLink(a.codigo),s=99*(a.porcentaje/100),e=(a.comisiones||[]).map(n=>{const o={pendiente:["Pendiente","warning"],solicitada:["Cobro solicitado","info"],pagada:["Pagada","success"],anulada:["Anulada","danger"]}[n.estado]||[n.estado,""];return`<tr>
                <td>${new Date(n.fecha).toLocaleDateString("es-ES")}</td>
                <td>Plan Fundador</td>
                <td style="font-family:var(--font-mono);">${this.eur(n.importe)}</td>
                <td><span class="badge ${o[1]}">${o[0]}</span></td>
            </tr>`}).join("");t.innerHTML=`
            <div class="glass-card afil-cab">
                <div>
                    <div class="tag-pill"><i class="ri-percent-line"></i> Programa de afiliados · ${a.porcentaje} % por venta</div>
                    <h2>Gana ${this.eur(s)} por cada Plan Fundador que traigas</h2>
                    <p>Comparte tu enlace. Cuando alguien entre por él y compre el Plan Fundador (99 €, pago único), la mitad es tuya. Se apunta sola en cuanto Stripe confirma el pago.</p>
                </div>
                <div class="afil-enlace">
                    <label for="affiliateLinkInput">Tu enlace de afiliado</label>
                    <div class="afil-enlace-fila">
                        <input type="text" id="affiliateLinkInput" readonly value="${this.esc(i)}" class="form-control">
                        <button type="button" id="copyAffiliateLinkBtn" class="btn btn-primary"><i class="ri-file-copy-line"></i> Copiar</button>
                    </div>
                    <small>Tu código: <strong style="font-family:var(--font-mono);">${this.esc(a.codigo)}</strong>. Vale también en cualquier página: <code>to-growth.com/blog/?ref=${this.esc(a.codigo)}</code></small>
                </div>
            </div>

            <div class="afil-cifras">
                <div class="glass-card afil-cifra"><span><i class="ri-cursor-line"></i> Clics en tu enlace</span><b>${a.clics}</b></div>
                <div class="glass-card afil-cifra"><span><i class="ri-user-add-line"></i> Cuentas creadas</span><b>${a.registros}</b></div>
                <div class="glass-card afil-cifra"><span><i class="ri-vip-crown-2-line"></i> Fundadores</span><b>${a.fundadores}</b></div>
                <div class="glass-card afil-cifra destacada"><span><i class="ri-money-euro-circle-line"></i> Pendiente de cobro</span><b>${this.eur(a.pendiente)}</b>${a.solicitado>0?`<em>${this.eur(a.solicitado)} en trámite</em>`:""}</div>
                <div class="glass-card afil-cifra"><span><i class="ri-bank-card-line"></i> Ya cobrado</span><b>${this.eur(a.pagado)}</b></div>
            </div>

            <div class="glass-card afil-tabla">
                <div class="flex-between" style="gap:12px; flex-wrap:wrap; margin-bottom:12px;">
                    <h3><i class="ri-history-line"></i> Tus comisiones</h3>
                    <button type="button" id="requestPayoutBtn" class="btn btn-highlight btn-sm" ${a.pendiente>0?"":"disabled"}><i class="ri-bank-card-line"></i> Solicitar cobro (${this.eur(a.pendiente)})</button>
                </div>
                ${e?`<div style="overflow-x:auto;"><table class="afil-t"><thead><tr><th>Fecha</th><th>Venta</th><th>Comisión</th><th>Estado</th></tr></thead><tbody>${e}</tbody></table></div>`:'<p style="color:var(--text-muted); font-size:14px; margin:0;">Todavía no hay ninguna venta atribuida a tu enlace. En cuanto alguien compre el Plan Fundador viniendo de él, aparecerá aquí.</p>'}
            </div>

            <div class="glass-card afil-como">
                <h3>Cómo funciona</h3>
                <ol>
                    <li><strong>Comparte tu enlace</strong> en tus redes, en tu canal o a tus contactos. Cada visita cuenta como clic.</li>
                    <li>Si esa persona <strong>crea su cuenta o paga</strong> en los 30 días siguientes, queda apuntada como tuya.</li>
                    <li>Cuando compra el <strong>Plan Fundador (99 €)</strong>, se te apunta <strong>${this.eur(s)}</strong> como pendiente.</li>
                    <li>Pulsa <strong>Solicitar cobro</strong> cuando quieras: te escribimos para hacerte el pago por transferencia o PayPal. Sin mínimo.</li>
                </ol>
                <p>No hay comisión sobre compras que hagas tú con tu propio enlace ni sobre cupones del 100 %.</p>
            </div>
        `}};window.Affiliates=Affiliates,document.addEventListener("DOMContentLoaded",()=>{Affiliates.init()});
