const Cookies={CLAVE:"to_growth_consentimiento",VERSION:1,GA_ID:"G-NSECQP7QL3",UMAMI_ID:"1493fff0-412e-4868-8a42-e59d02f5c2ac",_colaUmami:[],init(){this.consentModeDefecto(),this.cargarUmami();const e=this.leer();e?this.aplicar(e):setTimeout(()=>this.mostrarBanner(),1200),document.addEventListener("click",a=>{a.target.closest("#cookiesAceptarTodo")&&this.decidir({analitica:!0,marketing:!0}),a.target.closest("#cookiesRechazarTodo")&&this.decidir({analitica:!1,marketing:!1}),a.target.closest("#cookiesConfigurar")&&this.mostrarPanel(),a.target.closest("#cookiesGuardarPref")&&this.guardarDesdePanel(),a.target.closest(".abrirPreferenciasCookies")&&(a.preventDefault(),this.mostrarPanel())})},consentModeDefecto(){window.dataLayer=window.dataLayer||[],window.gtag=window.gtag||function(){window.dataLayer.push(arguments)},gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",functionality_storage:"granted",security_storage:"granted",wait_for_update:500})},leer(){try{const e=localStorage.getItem(this.CLAVE);if(!e)return null;const a=JSON.parse(e);return a.version!==this.VERSION?null:a}catch{return null}},decidir({analitica:e,marketing:a}){const t={version:this.VERSION,analitica:!!e,marketing:!!a,fecha:new Date().toISOString()};try{localStorage.setItem(this.CLAVE,JSON.stringify(t))}catch{}this.aplicar(t),this.cerrarTodo()},aplicar(e){gtag("consent","update",{analytics_storage:e.analitica?"granted":"denied",ad_storage:e.marketing?"granted":"denied",ad_user_data:e.marketing?"granted":"denied",ad_personalization:e.marketing?"granted":"denied"}),e.analitica&&this.cargarAnalitica()},cargarAnalitica(){if(!this.GA_ID||this._analiticaCargada)return;this._analiticaCargada=!0;const e=document.createElement("script");e.async=!0,e.src=`https://www.googletagmanager.com/gtag/js?id=${this.GA_ID}`,document.head.appendChild(e),gtag("js",new Date),gtag("config",this.GA_ID,{anonymize_ip:!0,send_page_view:!0})},cargarUmami(){if(!this.UMAMI_ID||this._umamiCargado)return;this._umamiCargado=!0;const e=document.createElement("script");e.defer=!0,e.src="https://cloud.umami.is/script.js",e.dataset.websiteId=this.UMAMI_ID,e.dataset.domains="to-growth.com",e.dataset.excludeHash="true",e.onload=()=>{this._colaUmami.forEach(a=>a()),this._colaUmami=[]},document.head.appendChild(e)},umami(e){this.UMAMI_ID&&(window.umami?e():this._colaUmami.push(e))},vistaApp(e){const a="/app/"+String(e||"").replace(/Tab$/,"").toLowerCase();this.umami(()=>window.umami.track(t=>({...t,url:a,title:"App: "+a.slice(5)})))},evento(e,a={}){const t={};Object.keys(a).forEach(o=>{const i=a[o];(typeof i=="string"||typeof i=="number"||typeof i=="boolean")&&(t[o]=i)}),this.umami(()=>window.umami.track(e,t));const n=this.leer();!n||!n.analitica||!this.GA_ID||gtag("event",e,a)},mostrarBanner(){if(document.getElementById("cookiesBanner"))return;const e=document.createElement("div");e.id="cookiesBanner",e.className="cookies-banner",e.setAttribute("role","dialog"),e.setAttribute("aria-live","polite"),e.setAttribute("aria-label","Aviso de cookies"),e.innerHTML=`
            <div class="cookies-texto">
                <strong>Usamos cookies</strong>
                <p>
                    Las necesarias para que la web funcione van siempre. Las de
                    análisis y publicidad, solo si tú quieres.
                    <a href="/legal/cookies">Política de cookies</a>.
                </p>
            </div>
            <div class="cookies-acciones">
                <button class="btn btn-outline btn-sm" id="cookiesConfigurar">Configurar</button>
                <button class="btn btn-outline btn-sm" id="cookiesRechazarTodo">Rechazar todo</button>
                <button class="btn btn-primary btn-sm" id="cookiesAceptarTodo">Aceptar todo</button>
            </div>
        `,document.body.appendChild(e)},mostrarPanel(){this.cerrarTodo();const e=this.leer()||{analitica:!1,marketing:!1},a=document.createElement("div");a.id="cookiesPanel",a.className="cookies-panel-fondo",a.innerHTML=`
            <div class="cookies-panel" role="dialog" aria-modal="true" aria-label="Preferencias de cookies">
                <h3>Preferencias de cookies</h3>

                <div class="cookies-fila">
                    <div>
                        <strong>Necesarias</strong>
                        <p>Mantienen tu sesión iniciada y recuerdan esta misma elección. Sin ellas la web no funciona.</p>
                    </div>
                    <span class="badge badge-success">Siempre activas</span>
                </div>

                <div class="cookies-fila">
                    <div>
                        <strong>Análisis</strong>
                        <p>Nos dicen qué páginas se visitan y dónde se atasca la gente, de forma agregada. Nos sirven para mejorar el producto.</p>
                    </div>
                    <label class="cookies-switch">
                        <input type="checkbox" id="cookiesAnalitica" ${e.analitica?"checked":""}>
                        <span></span>
                    </label>
                </div>

                <div class="cookies-fila">
                    <div>
                        <strong>Publicidad</strong>
                        <p>Permiten medir si los anuncios funcionan y no repetirte siempre el mismo.</p>
                    </div>
                    <label class="cookies-switch">
                        <input type="checkbox" id="cookiesMarketing" ${e.marketing?"checked":""}>
                        <span></span>
                    </label>
                </div>

                <div class="cookies-panel-pie">
                    <button class="btn btn-outline" id="cookiesRechazarTodo">Rechazar todo</button>
                    <button class="btn btn-primary" id="cookiesGuardarPref">Guardar preferencias</button>
                </div>
            </div>
        `,document.body.appendChild(a)},guardarDesdePanel(){this.decidir({analitica:!!document.getElementById("cookiesAnalitica")?.checked,marketing:!!document.getElementById("cookiesMarketing")?.checked})},cerrarTodo(){document.getElementById("cookiesBanner")?.remove(),document.getElementById("cookiesPanel")?.remove()}};window.Cookies=Cookies,document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>Cookies.init()):Cookies.init(),document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!(!a||typeof Cookies>"u"||!Cookies.evento)){var t=a.getAttribute("href")||"";a.hasAttribute("download")||t.indexOf("/descargas/")===0?Cookies.evento("file_download",{file_name:t.split("/").pop(),pagina:location.pathname}):t==="/reunion/"&&location.pathname!=="/reunion/"?Cookies.evento("clic_reunion",{pagina:location.pathname}):t==="/"&&/^\/(blog|para)\//.test(location.pathname)&&Cookies.evento("clic_buscador_desde_contenido",{pagina:location.pathname})}},!0);
