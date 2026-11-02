const Perfil={cache:{},local(){try{return JSON.parse(localStorage.getItem("to_growth_profile")||"{}")}catch{return{}}},esc(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")},nombreVisible(e){return e&&(e.nombre||e.agency_name||e.agencyName)||"Miembro"},iniciales(e){return this.nombreVisible(e).trim().split(/\s+/).slice(0,2).map(o=>o[0]||"").join("").toUpperCase()||"M"},avatarHTML(e,o){o=o||40;const a=e&&(e.avatar_url||e.avatarUrl),t=`width:${o}px;height:${o}px;`;return a&&a.length<=12e4&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a)?`<span class="avatar-foto" style="${t}"><img src="${a}" alt=""></span>`:`<span class="avatar-iniciales" style="${t}font-size:${Math.round(o*.38)}px">${this.esc(this.iniciales(e))}</span>`},fechaRelativa(e){const o=new Date(e).getTime();if(isNaN(o))return"";const a=Math.max(0,(Date.now()-o)/1e3);return a<60?"justo ahora":a<3600?`hace ${Math.floor(a/60)} min`:a<86400?`hace ${Math.floor(a/3600)} h`:a<604800?`hace ${Math.floor(a/86400)} d`:new Date(e).toLocaleDateString("es-ES",{day:"numeric",month:"short"})},autorHTML(e,o,a){const t=this.esc(this.nombreVisible(e)),i=[e&&e.agency_type,a?this.fechaRelativa(a):null].filter(Boolean).map(n=>this.esc(n)).join(" · "),r=e&&e.role==="admin";return`
            <button type="button" class="autor-chip" data-perfil="${this.esc(o)}" title="Ver perfil">
                ${this.avatarHTML(e,40)}
                <span class="autor-texto">
                    <strong>${t}${r?' <span class="badge badge-accent" style="font-size:10px; padding:1px 6px;">Fundador de To Growth</span>':""}</strong>
                    <small>${i}</small>
                </span>
            </button>`},async cargarPublicos(e){const o=[...new Set(e)].filter(t=>t&&!this.cache[t]);if(o.length&&typeof getSupabase=="function"){const t=getSupabase();if(t){const{data:i,error:r}=await t.rpc("perfiles_publicos_de",{ids:o});r&&console.warn("No se pudieron leer perfiles públicos:",r.message),(i||[]).forEach(n=>{this.cache[n.id]=n})}}const a={};return e.forEach(t=>{a[t]=this.cache[t]||null}),a},async abrirPublico(e){if(!e)return;const a=(await this.cargarPublicos([e]))[e];let t=document.getElementById("perfilPublicoModal");t||(t=document.createElement("div"),t.id="perfilPublicoModal",t.className="modal-backdrop hidden",t.innerHTML=`
                <div class="modal-dialog glass-card small-modal" style="max-width: 440px;">
                    <div class="modal-header">
                        <h3 style="margin:0; font-size:18px;">Perfil</h3>
                        <button class="modal-close" type="button" id="cerrarPerfilPublico">&times;</button>
                    </div>
                    <div class="modal-body" id="perfilPublicoCuerpo"></div>
                </div>`,document.body.appendChild(t),t.querySelector("#cerrarPerfilPublico").onclick=()=>t.classList.add("hidden"),t.addEventListener("click",r=>{r.target===t&&t.classList.add("hidden")}));const i=t.querySelector("#perfilPublicoCuerpo");if(!a)i.innerHTML='<p class="text-muted" style="text-align:center;">Este miembro todavía no ha completado su perfil.</p>';else{const r=n=>{const s=String(n||"").trim();return s?/^https?:\/\//i.test(s)?s:"https://"+s:""};i.innerHTML=`
                <div class="perfil-publico">
                    ${this.avatarHTML(a,96)}
                    <h3>${this.esc(this.nombreVisible(a))}</h3>
                    ${a.role==="admin"?'<span class="badge badge-accent">Fundador de To Growth</span>':""}
                    ${a.agency_name&&a.nombre?`<p class="perfil-publico-empresa">${this.esc(a.agency_name)}${a.agency_type?" · "+this.esc(a.agency_type):""}</p>`:a.agency_type?`<p class="perfil-publico-empresa">${this.esc(a.agency_type)}</p>`:""}
                    ${a.user_bio?`<p class="perfil-publico-bio">${this.esc(a.user_bio)}</p>`:""}
                    <div class="perfil-publico-enlaces">
                        ${r(a.web)?`<a class="btn btn-outline btn-sm" href="${this.esc(r(a.web))}" target="_blank" rel="noopener noreferrer nofollow"><i class="ri-global-line"></i> Web</a>`:""}
                        ${r(a.linkedin)?`<a class="btn btn-outline btn-sm" href="${this.esc(r(a.linkedin))}" target="_blank" rel="noopener noreferrer nofollow"><i class="ri-linkedin-box-line"></i> LinkedIn</a>`:""}
                    </div>
                </div>`}t.classList.remove("hidden")},render(){const e=document.getElementById("perfilTabContent");if(!e)return;const o=this.local(),a=t=>this.esc(o[t]||"");e.innerHTML=`
            <div class="perfil-grid">
                <div class="glass-card settings-card perfil-seccion">
                    <h3><i class="ri-user-3-line"></i> Cómo te ven los demás</h3>
                    <p class="text-muted" style="font-size:13.5px;">Aparece junto a tus mensajes en la comunidad y en los comentarios de la academia.</p>

                    <div class="perfil-foto-zona">
                        <div id="perfilFotoPreview">${this.avatarHTML(o,88)}</div>
                        <div>
                            <label class="btn btn-outline btn-sm" for="perfilFotoInput" style="cursor:pointer;"><i class="ri-camera-line"></i> Cambiar foto</label>
                            <input type="file" id="perfilFotoInput" accept="image/*" style="display:none;">
                            ${o.avatarUrl?'<button type="button" class="btn btn-sm" id="perfilFotoQuitar" style="background:none; color:var(--text-muted);">Quitar</button>':""}
                            <small class="text-muted">JPG o PNG. Se recorta y reduce sola.</small>
                        </div>
                    </div>

                    <div class="perfil-fila">
                        <div class="form-group"><label for="pfNombre">Tu nombre</label><input type="text" id="pfNombre" class="form-control" value="${a("nombre")}" placeholder="Ej: Mateo Martínez"></div>
                        <div class="form-group"><label for="pfEmpresa">Empresa o marca</label><input type="text" id="pfEmpresa" class="form-control" value="${a("agencyName")}" placeholder="Ej: Growthify"></div>
                    </div>
                    <div class="form-group"><label for="pfTipo">A qué te dedicas</label><input type="text" id="pfTipo" class="form-control" value="${a("agencyType")}" placeholder="Ej: Agencia de marketing para clínicas"></div>
                    <div class="form-group"><label for="pfBio">Presentación corta</label><input type="text" id="pfBio" class="form-control" value="${a("userBio")}" maxlength="200" placeholder="Ej: Ayudo a clínicas a llenar la agenda con Meta Ads."></div>
                    <div class="perfil-fila">
                        <div class="form-group"><label for="pfWeb">Web</label><input type="url" id="pfWeb" class="form-control" value="${a("web")}" placeholder="https://"></div>
                        <div class="form-group"><label for="pfLinkedin">LinkedIn</label><input type="url" id="pfLinkedin" class="form-control" value="${a("linkedin")}" placeholder="https://www.linkedin.com/in/..."></div>
                    </div>
                </div>

                <div class="glass-card settings-card perfil-seccion">
                    <h3><i class="ri-phone-line"></i> Tu negocio</h3>
                    <p class="text-muted" style="font-size:13.5px;">Lo usan el buscador y los guiones de llamada. Cuanto más concreto, mejor salen.</p>

                    <div class="perfil-fila">
                        <div class="form-group"><label for="pfNicho">A quién vendes</label><input type="text" id="pfNicho" class="form-control" value="${a("targetNiche")}" placeholder="Ej: clínicas dentales"></div>
                        <div class="form-group"><label for="pfZona">Dónde buscas clientes</label><input type="text" id="pfZona" class="form-control" value="${a("targetLocation")}" placeholder="Ej: Madrid, España"></div>
                    </div>
                    <div class="form-group"><label for="pfOferta">Qué ofreces</label><textarea id="pfOferta" class="form-control" rows="2" placeholder="Tu propuesta principal, en una o dos frases">${a("mainOffer")}</textarea></div>
                    <div class="form-group"><label for="pfCaso">Un resultado concreto que hayas conseguido</label><input type="text" id="pfCaso" class="form-control" value="${a("casoExito")}" placeholder="Ej: a una clínica de Valencia le subimos las reservas un 30% en dos meses"><small>Sector, cifra y plazo. Es la frase que hace que no te cuelguen.</small></div>
                    <div class="form-group"><label for="pfDif">Por qué tú y no el de al lado</label><input type="text" id="pfDif" class="form-control" value="${a("diferenciador")}" placeholder="Ej: solo trabajo con clínicas, conozco su temporada baja"></div>
                    <div class="perfil-fila">
                        <div class="form-group"><label for="pfCta">Qué quieres conseguir en la llamada</label><input type="text" id="pfCta" class="form-control" value="${a("mainCallToAction")}" placeholder="Ej: una reunión de 15 minutos"></div>
                        <div class="form-group"><label for="pfTono">Tono de los guiones</label><input type="text" id="pfTono" class="form-control" value="${a("pitchTone")}" placeholder="Ej: consultivo y directo"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:0;"><label for="pfObjecion">La objeción que más te dicen</label><input type="text" id="pfObjecion" class="form-control" value="${a("mainObjection")}" placeholder="Ej: ya tengo proveedor"></div>
                </div>
            </div>

            <div class="glass-card settings-card perfil-seccion" style="max-width: var(--ancho-lectura); margin-top: 24px;">
                <h3><i class="ri-mail-line"></i> Qué correos quieres recibir</h3>
                <label class="auth-casilla"><input type="checkbox" id="pfNovedades" ${o.aceptaNovedades?"checked":""}><span><strong>Novedades y consejos de venta.</strong> Uno o dos correos al mes con lo que funciona para captar clientes. Nada de spam.</span></label>
                <label class="auth-casilla"><input type="checkbox" id="pfNotifComunidad" ${o.notifComunidad===!1?"":"checked"}><span><strong>Avisos de la comunidad.</strong> Cuando alguien responde a un mensaje tuyo o a un comentario de una lección.</span></label>
                <small class="text-muted" style="display:block; margin-top:8px;">Los correos del servicio (confirmar cuenta, recuperar contraseña, pagos) llegan siempre.</small>
            </div>

            <div class="perfil-acciones">
                <button type="button" class="btn btn-primary btn-lg" id="perfilGuardarBtn"><i class="ri-save-3-line"></i> Guardar perfil</button>
                <span class="text-muted" id="perfilEstado" style="font-size:13px;"></span>
            </div>`,this.fotoPendiente=void 0,this.bindPanel()},bindPanel(){const e=document.getElementById("perfilFotoInput");e&&(e.onchange=async()=>{const t=e.files&&e.files[0];if(t){if(!/^image\//.test(t.type)){typeof App<"u"&&App.showToast&&App.showToast("Elige una imagen (JPG o PNG).","warning");return}try{this.fotoPendiente=await this.redimensionar(t);const i=document.getElementById("perfilFotoPreview");i&&(i.innerHTML=this.avatarHTML({avatar_url:this.fotoPendiente,nombre:"x"},88))}catch(i){console.error("No se pudo procesar la foto:",i),typeof App<"u"&&App.showToast&&App.showToast("No se pudo leer esa imagen.","error")}}});const o=document.getElementById("perfilFotoQuitar");o&&(o.onclick=()=>{this.fotoPendiente=null;const t=document.getElementById("perfilFotoPreview"),i=this.local();t&&(t.innerHTML=this.avatarHTML({nombre:i.nombre,agencyName:i.agencyName},88))});const a=document.getElementById("perfilGuardarBtn");a&&(a.onclick=()=>this.guardar())},redimensionar(e){return new Promise((o,a)=>{const t=new Image,i=URL.createObjectURL(e);t.onload=()=>{try{const n=document.createElement("canvas");n.width=160,n.height=160;const s=n.getContext("2d"),l=Math.min(t.width,t.height),c=(t.width-l)/2,d=(t.height-l)/2;s.drawImage(t,c,d,l,l,0,0,160,160),URL.revokeObjectURL(i),o(n.toDataURL("image/jpeg",.82))}catch(r){a(r)}},t.onerror=()=>{URL.revokeObjectURL(i),a(new Error("imagen no válida"))},t.src=i})},async guardar(){const e=n=>(document.getElementById(n)?.value||"").trim(),o=this.local(),a=Object.assign({},o,{nombre:e("pfNombre"),agencyName:e("pfEmpresa")||o.agencyName||"Mi Empresa",agencyType:e("pfTipo"),userBio:e("pfBio"),web:e("pfWeb"),linkedin:e("pfLinkedin"),targetNiche:e("pfNicho"),targetLocation:e("pfZona"),mainOffer:e("pfOferta"),casoExito:e("pfCaso"),diferenciador:e("pfDif"),mainCallToAction:e("pfCta"),pitchTone:e("pfTono"),mainObjection:e("pfObjecion"),aceptaNovedades:!!document.getElementById("pfNovedades")?.checked,notifComunidad:!!document.getElementById("pfNotifComunidad")?.checked,updatedAt:new Date().toISOString()});this.fotoPendiente===null?a.avatarUrl="":typeof this.fotoPendiente=="string"&&(a.avatarUrl=this.fotoPendiente);const t=document.getElementById("perfilEstado"),i=document.getElementById("perfilGuardarBtn");i&&(i.disabled=!0),t&&(t.textContent="Guardando…"),localStorage.setItem("to_growth_profile",JSON.stringify(a));let r=!1;try{const n=typeof getSupabase=="function"?getSupabase():null;if(n){const{data:{session:s}}=await n.auth.getSession();if(s&&s.user){const l=PerfilMapper.aFila(s.user.id,a);a.avatarUrl===""&&(l.avatar_url=null);const{error:c}=await n.from("profiles").update(l).eq("id",s.user.id);c?console.error("No se pudo guardar el perfil:",c.message):(r=!0,delete this.cache[s.user.id])}}}catch(n){console.error("Error guardando el perfil:",n)}if(i&&(i.disabled=!1),t&&(t.textContent=r?"Guardado.":"Guardado en este navegador, pero no en tu cuenta. Inténtalo de nuevo."),typeof App<"u"&&App.showToast&&App.showToast(r?"Perfil guardado.":"No se pudo guardar en tu cuenta. Inténtalo de nuevo.",r?"success":"warning"),this.actualizarCabecera(),typeof Onboarding<"u"&&Onboarding.loadProfile&&Onboarding.loadProfile(),r){this.render();const n=document.getElementById("perfilEstado");n&&(n.textContent="Guardado.")}},actualizarCabecera(){const e=this.local(),o=document.getElementById("sbAvatar");o&&(o.innerHTML=this.avatarHTML(e,40));const a=document.getElementById("userNameDisplay");a&&e.nombre&&(a.textContent=e.nombre);const t=document.getElementById("sbAgencyName");t&&(t.textContent=e.agencyName||e.nombre||"Mi Empresa")}};document.addEventListener("click",e=>{const o=e.target.closest(".autor-chip[data-perfil]");o&&(e.preventDefault(),Perfil.abrirPublico(o.dataset.perfil))}),document.addEventListener("DOMContentLoaded",()=>{Perfil.actualizarCabecera()}),window.Perfil=Perfil;
