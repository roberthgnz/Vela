const Community={currentRoom:"presentaciones",posts:[],yo:null,soyAdmin:!1,salas:{presentaciones:{titulo:"#presentaciones",icono:"💬",desc:"Preséntate: quién eres, qué vendes y a quién."},"estrategias-b2b":{titulo:"#estrategias-b2b",icono:"🚀",desc:"Lo que te está funcionando para captar clientes, y lo que no."},"logros-y-ventas":{titulo:"#logros-y-ventas",icono:"🏆",desc:"Reuniones cerradas, clientes nuevos. Aquí se celebra."},"soporte-estrategia":{titulo:"#soporte-estrategia",icono:"🎯",desc:"Dudas de venta. Las responde Mateo."},"punto-de-situacion":{titulo:"#punto-de-situacion",icono:"📍",desc:"Cada viernes: llamadas hechas, reuniones, cierres y qué vas a cambiar la semana que viene."},"dudas-tecnicas":{titulo:"#dudas-tecnicas",icono:"🛠️",desc:"Dominios, correo, web, herramientas. Lo técnico que te frena."},directos:{titulo:"#directos",icono:"🎬",desc:"Sesiones en directo y preguntas y respuestas: fechas, enlaces y grabaciones."}},init(){this.bindEvents(),this.renderCommunityTab()},esc(e){return Perfil.esc(e)},async sesion(){const e=typeof getSupabase=="function"?getSupabase():null;if(!e)return null;const{data:{session:s}}=await e.auth.getSession();return s&&s.user?s:null},async cargar(){const e=getSupabase(),s=await this.sesion();if(this.yo=s?s.user.id:null,!this.yo)return this.posts=[],{error:"Inicia sesión para ver la comunidad."};const{data:t,error:i}=await e.from("comunidad_posts").select("id, user_id, sala, texto, created_at").eq("sala",this.currentRoom).order("created_at",{ascending:!1}).limit(50);if(i)return{error:i.message};const a=t.map(n=>n.id);let d=[],o=[];if(a.length){const n=await e.from("comunidad_respuestas").select("id, post_id, user_id, texto, created_at").in("post_id",a).order("created_at",{ascending:!0}),r=await e.from("comunidad_likes").select("post_id, user_id").in("post_id",a);d=n.data||[],o=r.data||[]}const l=[...t.map(n=>n.user_id),...d.map(n=>n.user_id),this.yo],c=await Perfil.cargarPublicos(l);return this.soyAdmin=!!(c[this.yo]&&c[this.yo].role==="admin"),this.posts=t.map(n=>({...n,autor:c[n.user_id],respuestas:d.filter(r=>r.post_id===n.id).map(r=>({...r,autor:c[r.user_id]})),likes:o.filter(r=>r.post_id===n.id).length,meGusta:o.some(r=>r.post_id===n.id&&r.user_id===this.yo)})),{}},async publicar(e){const s=getSupabase();if(!this.yo)return;const{error:t}=await s.from("comunidad_posts").insert({user_id:this.yo,sala:this.currentRoom,texto:e});return t?(console.error("No se pudo publicar:",t.message),typeof App<"u"&&App.showToast&&App.showToast("No se pudo publicar. "+this.explicar(t),"error"),!1):!0},async responder(e,s){const t=getSupabase(),{error:i}=await t.from("comunidad_respuestas").insert({user_id:this.yo,post_id:e,texto:s});return i?(console.error("No se pudo responder:",i.message),typeof App<"u"&&App.showToast&&App.showToast("No se pudo responder. "+this.explicar(i),"error"),!1):!0},async alternarLike(e){const s=getSupabase(),t=this.posts.find(i=>i.id===e);t&&(t.meGusta?await s.from("comunidad_likes").delete().eq("post_id",e).eq("user_id",this.yo):await s.from("comunidad_likes").insert({post_id:e,user_id:this.yo}))},async borrar(e,s){const t=getSupabase(),{error:i}=await t.from(e).delete().eq("id",s);i&&typeof App<"u"&&App.showToast&&App.showToast("No se pudo borrar.","error")},explicar(e){const s=e&&e.message||"";return/row-level security|policy/i.test(s)?"La comunidad es del Plan Fundador.":/does not exist/i.test(s)?"La comunidad se está preparando.":""},bindEvents(){document.addEventListener("click",async e=>{const s=e.target.closest(".communityRoomBtn");if(s){e.preventDefault(),this.currentRoom=s.dataset.room,this.renderCommunityTab();return}const t=e.target.closest(".likePostBtn");if(t){e.preventDefault(),t.disabled=!0,await this.alternarLike(t.dataset.id),await this.refrescar();return}const i=e.target.closest(".submitPostCommentBtn");if(i){e.preventDefault();const o=document.getElementById(`postCommentInput_${i.dataset.id}`),l=o?o.value.trim():"";if(!l)return;i.disabled=!0,await this.responder(i.dataset.id,l)?await this.refrescar():i.disabled=!1;return}const a=e.target.closest(".borrarComunidadBtn");if(a){if(e.preventDefault(),!confirm("¿Borrar este mensaje?"))return;await this.borrar(a.dataset.tabla,a.dataset.id),await this.refrescar();return}const d=e.target.closest("#submitNewCommunityPostBtn");if(d){e.preventDefault();const o=document.getElementById("newCommunityPostText"),l=o?o.value.trim():"";if(!l)return;d.disabled=!0,await this.publicar(l)&&(o&&(o.value=""),typeof App<"u"&&App.showToast&&App.showToast("Publicado.","success"),await this.refrescar()),d.disabled=!1}})},async refrescar(){const e=await this.cargar();this.pintarFeed(e.error)},renderCommunityTab(){const e=document.getElementById("communityTabContent");if(!e)return;if(typeof Plan<"u"&&!Plan.esFundador()){e.innerHTML=Plan.bloqueo({icono:"ri-team-line",titulo:"La comunidad es del Plan Fundador",descripcion:"Dentro se comparten estrategias de captación que funcionan, se revisan casos reales entre miembros y se resuelven dudas de venta. No es un chat: es donde se aprende lo que no cabe en un vídeo."});return}const s=this.salas[this.currentRoom]||this.salas.presentaciones,t=Perfil.local();e.innerHTML=`
            <div style="display: grid; grid-template-columns: 240px 1fr; gap: 24px;">
                <div class="glass-card" style="padding: 18px; align-self: start;">
                    <h4 style="color: var(--text-main); font-size: 14px; font-weight: 700; margin-bottom: 12px;">
                        <i class="ri-team-line" style="color: var(--primary);"></i> Salas
                    </h4>
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        ${Object.entries(this.salas).map(([i,a])=>`
                            <button class="btn btn-sm ${this.currentRoom===i?"btn-primary":"btn-outline"} communityRoomBtn" data-room="${i}" style="text-align: left; justify-content: flex-start;">
                                ${a.icono} ${a.titulo}
                            </button>`).join("")}
                    </div>
                    <div style="margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-light); font-size: 12px; color: var(--text-muted);">
                        <p>Tu nombre y tu foto salen de <strong>Mi Perfil</strong>. <a href="#" class="irAMiPerfil" style="color:var(--acento-claro);">Completarlo</a>.</p>
                    </div>
                </div>

                <div>
                    <div class="glass-card margin-bottom-lg" style="padding: 18px;">
                        <h4 style="color: var(--text-main); font-size: 15px; font-weight: 700; margin-bottom: 4px;">${s.icono} ${s.titulo}</h4>
                        <p class="text-muted" style="font-size: 13px; margin-bottom: 12px;">${s.desc}</p>
                        <div style="display:flex; gap:10px; align-items:flex-start;">
                            ${Perfil.avatarHTML(t,36)}
                            <textarea id="newCommunityPostText" class="form-control" rows="3" maxlength="4000" placeholder="Escribe para la comunidad…" style="flex:1;"></textarea>
                        </div>
                        <div style="text-align: right; margin-top: 8px;">
                            <button type="button" id="submitNewCommunityPostBtn" class="btn btn-primary">
                                <i class="ri-send-plane-fill"></i> Publicar
                            </button>
                        </div>
                    </div>

                    <div id="communityFeed" style="display: flex; flex-direction: column; gap: 14px;">
                        <div class="glass-card text-center" style="padding: 30px; color: var(--text-muted);">Cargando…</div>
                    </div>
                </div>
            </div>`,e.querySelector(".irAMiPerfil").onclick=i=>{i.preventDefault(),typeof App<"u"&&App.switchTab("perfilTab")},this.refrescar()},pintarFeed(e){const s=document.getElementById("communityFeed");if(s){if(e){s.innerHTML=`<div class="glass-card text-center" style="padding: 30px; color: var(--text-muted);">
                <i class="ri-error-warning-line" style="font-size: 30px;"></i>
                <p style="margin-top: 8px;">${this.esc(this.explicar({message:e})||"No se pudo cargar la comunidad. Inténtalo en un momento.")}</p>
            </div>`;return}if(!this.posts.length){s.innerHTML=`<div class="glass-card text-center" style="padding: 36px; color: var(--text-muted);">
                <i class="ri-chat-smile-2-line" style="font-size: 36px;"></i>
                <p style="margin-top: 8px;">Todavía no hay mensajes en esta sala. Sé quien la estrena.</p>
            </div>`;return}s.innerHTML=this.posts.map(t=>{const i=t.user_id===this.yo||this.soyAdmin;return`
            <div class="glass-card" style="padding: 18px;">
                <div class="flex-between" style="align-items:flex-start;">
                    ${Perfil.autorHTML(t.autor,t.user_id,t.created_at)}
                    ${i?`<button type="button" class="btn btn-sm borrarComunidadBtn" data-tabla="comunidad_posts" data-id="${t.id}" title="Borrar" style="background:none; color:var(--text-dim);"><i class="ri-delete-bin-line"></i></button>`:""}
                </div>

                <p style="font-size: 14px; color: #e2e8f0; line-height: 1.6; white-space: pre-line; margin: 12px 0 14px;">${this.esc(t.texto)}</p>

                <div class="flex-between" style="border-top: 1px solid rgba(255,255,255,0.05); padding-top: 10px;">
                    <button type="button" class="btn btn-sm ${t.meGusta?"btn-primary":"btn-outline"} likePostBtn" data-id="${t.id}">
                        <i class="${t.meGusta?"ri-heart-3-fill":"ri-heart-3-line"}"></i> ${t.likes}
                    </button>
                    <span style="font-size: 12px; color: var(--text-muted);"><i class="ri-chat-1-line"></i> ${t.respuestas.length} ${t.respuestas.length===1?"respuesta":"respuestas"}</span>
                </div>

                ${t.respuestas.length?`
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 8px;">
                        ${t.respuestas.map(a=>`
                            <div class="comunidad-respuesta">
                                ${Perfil.autorHTML(a.autor,a.user_id,a.created_at)}
                                <p>${this.esc(a.texto)}</p>
                                ${a.user_id===this.yo||this.soyAdmin?`<button type="button" class="btn btn-sm borrarComunidadBtn" data-tabla="comunidad_respuestas" data-id="${a.id}" title="Borrar" style="background:none; color:var(--text-dim); position:absolute; top:6px; right:6px;"><i class="ri-delete-bin-line"></i></button>`:""}
                            </div>`).join("")}
                    </div>`:""}

                <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <input type="text" id="postCommentInput_${t.id}" class="form-control" maxlength="2000" placeholder="Responder…" style="padding: 6px 10px; font-size: 13px; flex: 1;">
                    <button type="button" class="btn btn-sm btn-outline submitPostCommentBtn" data-id="${t.id}">Responder</button>
                </div>
            </div>`}).join("")}}};document.addEventListener("DOMContentLoaded",()=>{Community.init()}),window.Community=Community;
