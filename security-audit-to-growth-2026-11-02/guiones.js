const Guiones={CLAVE:"to_growth_guiones",CLAVE_CAMPANAS:"to_growth_secuencias",MAX:50,leer(a){try{const t=JSON.parse(localStorage.getItem(a)||"[]");return Array.isArray(t)?t:[]}catch{return[]}},esc(a){return String(a??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t])},limpio(a){const t=["h3","h4","h5","p","ul","ol","li","strong","em","b","i","br","blockquote"];return String(a||"").replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|form)\b[\s\S]*?<\/\1\s*>/gi,"").replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g,(i,s)=>(s=s.toLowerCase(),t.includes(s)?i.startsWith("</")?`</${s}>`:`<${s}>`:""))},guardar(a,t){if(!a||!t)return;const i=this.leer(this.CLAVE).filter(s=>s.id!==a.id);i.unshift({id:a.id,empresa:a.name||"Empresa",ciudad:a.city||a.location||"",fecha:new Date().toISOString(),html:this.limpio(t)});try{localStorage.setItem(this.CLAVE,JSON.stringify(i.slice(0,this.MAX)))}catch{}this.render(),window.Prospector&&Prospector.updateStats&&Prospector.updateStats()},total(){return this.leer(this.CLAVE).length},quitar(a,t){const i=this.leer(a);i.splice(t,1);try{localStorage.setItem(a,JSON.stringify(i))}catch{}this.render(),window.Prospector&&Prospector.updateStats&&Prospector.updateStats()},render(){const a=document.getElementById("savedScriptsGrid");if(!a)return;const t=this.leer(this.CLAVE),i=this.leer(this.CLAVE_CAMPANAS),s=e=>{try{return new Date(e).toLocaleDateString("es-ES",{day:"numeric",month:"short"})}catch{return""}},r={llamada:"Llamada",email:"Email",linkedin:"LinkedIn"};if(!t.length&&!i.length){a.innerHTML=`
                <div class="guiones-vacio">
                    <i class="ri-draft-line"></i>
                    <h4>Todavía no tienes guiones</h4>
                    <p>Abre una empresa en el buscador o en el organizador y pulsa «Guion IA». El guion se guarda aquí solo. Las campañas que guardes desde el asistente también aparecen aquí.</p>
                </div>`;return}a.innerHTML=`
            ${t.length?`<h3 class="guiones-tit">Guiones de llamada <span>${t.length}</span></h3>`:""}
            ${t.map((e,n)=>`
                <details class="guion-item">
                    <summary>
                        <span class="guion-ic"><i class="ri-phone-line"></i></span>
                        <span class="guion-txt"><strong>${this.esc(e.empresa)}</strong><small>${this.esc(e.ciudad)}${e.ciudad?" · ":""}${s(e.fecha)}</small></span>
                        <i class="ri-arrow-down-s-line guion-flecha"></i>
                    </summary>
                    <div class="guion-cuerpo">
                        <div class="guion-html">${this.limpio(e.html)}</div>
                        <div class="guion-botones">
                            <button type="button" class="btn btn-outline btn-sm" data-guion-copiar="${n}"><i class="ri-file-copy-line"></i> Copiar</button>
                            <button type="button" class="btn btn-outline btn-sm" data-guion-quitar="${n}"><i class="ri-delete-bin-line"></i> Quitar</button>
                        </div>
                    </div>
                </details>`).join("")}
            ${i.length?`<h3 class="guiones-tit">Campañas del asistente <span>${i.length}</span></h3>`:""}
            ${i.map((e,n)=>`
                <details class="guion-item">
                    <summary>
                        <span class="guion-ic"><i class="ri-sparkling-2-line"></i></span>
                        <span class="guion-txt"><strong>${this.esc(e.nombre)}</strong><small>${this.esc(e.cliente||"")}${e.cliente?" · ":""}${(e.pasos||[]).length} pasos${e.creada?" · "+s(e.creada):""}</small></span>
                        <i class="ri-arrow-down-s-line guion-flecha"></i>
                    </summary>
                    <div class="guion-cuerpo">
                        ${(e.pasos||[]).map(o=>`
                            <div class="guion-paso">
                                <b>Día ${this.esc(o.dia)} · ${r[o.canal]||"Email"}${o.asunto?" — "+this.esc(o.asunto):""}</b>
                                <p>${this.esc(o.texto).replace(/\n/g,"<br>")}</p>
                            </div>`).join("")}
                        <div class="guion-botones">
                            <button type="button" class="btn btn-outline btn-sm" data-campana-copiar="${n}"><i class="ri-file-copy-line"></i> Copiar todo</button>
                            <button type="button" class="btn btn-outline btn-sm" data-campana-quitar="${n}"><i class="ri-delete-bin-line"></i> Quitar</button>
                        </div>
                    </div>
                </details>`).join("")}`},async copiar(a,t){try{await navigator.clipboard.writeText(a),t.innerHTML='<i class="ri-check-line"></i> Copiado'}catch{t.textContent="No se pudo copiar"}},init(){this.render(),document.addEventListener("click",a=>{const t=a.target.closest("[data-guion-copiar],[data-guion-quitar],[data-campana-copiar],[data-campana-quitar]");if(t){if(t.dataset.guionCopiar!=null){const i=t.closest(".guion-cuerpo").querySelector(".guion-html");this.copiar(i?i.innerText:"",t)}else if(t.dataset.guionQuitar!=null)this.quitar(this.CLAVE,+t.dataset.guionQuitar);else if(t.dataset.campanaCopiar!=null){const i=this.leer(this.CLAVE_CAMPANAS)[+t.dataset.campanaCopiar];i&&this.copiar((i.pasos||[]).map(s=>`Día ${s.dia} · ${s.canal}${s.asunto?`
Asunto: `+s.asunto:""}
${s.texto}`).join(`

`),t)}else t.dataset.campanaQuitar!=null&&this.quitar(this.CLAVE_CAMPANAS,+t.dataset.campanaQuitar);return}a.target.closest('.sidebar-link[data-target="scriptsTab"]')&&setTimeout(()=>this.render(),50)})}};window.Guiones=Guiones,document.addEventListener("DOMContentLoaded",()=>Guiones.init());
