const Academy={modulesData:window.ACADEMIA_MODULOS||[],rutas:window.ACADEMIA_RUTAS||[],init(){this.renderModulesGrid()},async cargarComentarios(o){const s=document.getElementById("lessonCommentsList"),n=document.getElementById("lessonCommentsCount");if(!s)return;const a=typeof getSupabase=="function"?getSupabase():null;if(!a)return;const{data:r,error:l}=await a.from("academia_comentarios").select("id, user_id, texto, created_at").eq("leccion",o).order("created_at",{ascending:!1}).limit(100);if(l){s.innerHTML='<p class="text-muted" style="font-size:13px;">No se pudieron cargar los comentarios.</p>';return}if(n&&(n.textContent=r.length?`(${r.length})`:""),!r.length){s.innerHTML='<p class="text-muted" style="font-size:13px;">Nadie ha comentado todavía este episodio. Si tienes una duda, es el sitio.</p>';return}const{data:{session:d}}=await a.auth.getSession(),c=d?d.user.id:null,e=await Perfil.cargarPublicos([...r.map(t=>t.user_id),c]),i=!!(c&&e[c]&&e[c].role==="admin");s.innerHTML=r.map(t=>`
            <div class="comunidad-respuesta">
                ${Perfil.autorHTML(e[t.user_id],t.user_id,t.created_at)}
                <p>${Perfil.esc(t.texto)}</p>
                ${t.user_id===c||i?`<button type="button" class="btn btn-sm borrarComentarioBtn" data-id="${t.id}" title="Borrar" style="background:none; color:var(--text-dim); position:absolute; top:6px; right:6px;"><i class="ri-delete-bin-line"></i></button>`:""}
            </div>`).join(""),s.querySelectorAll(".borrarComentarioBtn").forEach(t=>{t.onclick=async()=>{confirm("¿Borrar este comentario?")&&(await a.from("academia_comentarios").delete().eq("id",t.dataset.id),this.cargarComentarios(o))}})},async publicarComentario(o,s){const n=typeof getSupabase=="function"?getSupabase():null;if(!n)return!1;const{data:{session:a}}=await n.auth.getSession();if(!a)return typeof App<"u"&&App.showToast&&App.showToast("Inicia sesión para comentar.","warning"),!1;const{error:r}=await n.from("academia_comentarios").insert({leccion:o,user_id:a.user.id,texto:s});return r?(console.error("No se pudo publicar el comentario:",r.message),typeof App<"u"&&App.showToast&&App.showToast("No se pudo publicar el comentario.","error"),!1):!0},fechaLegible(o){if(!o)return"";const s=new Date(o+"T12:00:00");return s.toLocaleDateString("es-ES",{day:"numeric",month:"long"})+(s.getFullYear()!==new Date().getFullYear()?" de "+s.getFullYear():"")},estadoModulo(o){const s=o.lessons.length,n=o.lessons.filter(a=>a.video).length;return n===s?{clase:"listo",texto:"Disponible",publicados:n,total:s}:n>0?{clase:"parcial",texto:`${n} de ${s} publicados`,publicados:n,total:s}:o.disponible?{clase:"fecha",texto:"Disponible el "+this.fechaLegible(o.disponible),publicados:n,total:s}:{clase:"votar",texto:"Próximamente · lo decide la comunidad",publicados:n,total:s}},progresoModulo(o){try{const s=JSON.parse(localStorage.getItem("to_growth_episodios_vistos")||"[]");if(!o.lessons.length)return 0;const n=o.lessons.filter(a=>s.includes(o.id+"_"+a.id)).length;return Math.round(n/o.lessons.length*100)}catch{return 0}},marcarLeccionVista(o,s){try{const n=JSON.parse(localStorage.getItem("to_growth_episodios_vistos")||"[]"),a=o+"_"+s;n.includes(a)||(n.push(a),localStorage.setItem("to_growth_episodios_vistos",JSON.stringify(n)))}catch{}},directorio:[{cat:"Encontrar empresas y decisores",icon:"ri-search-eye-line",intro:"Antes de llamar hace falta una lista. Estas son las fuentes que usamos, de la más rápida a la más completa.",tools:[{n:"Buscador de To Growth",q:"Empresas de un sector y una ciudad con web y teléfono, marcadas si no tienen web.",c:"Incluido en tu plan",pasos:["Escribe sector y ciudad (“clínicas dentales, Valencia”) y pulsa buscar.","Guarda las diez que encajen en una lista con nombre (por ejemplo “Semana 36”).","Abre cada una en el organizador y genera su guion antes de llamar."],tip:"Busca ciudades medianas: menos competencia llamando y el dueño coge el teléfono."},{n:"Google Maps + extractor",q:"Negocios locales con reseñas, horario y teléfono. La fuente más completa para servicios locales.",c:"Gratis (extensión gratuita)",pasos:["Busca en Google Maps “restaurantes en Bilbao” y baja hasta cargar unos 60 resultados.","Con la extensión Instant Data Scraper exporta nombre, teléfono, web y valoración a Excel.","Filtra los que tengan menos de 4 estrellas o sin web: ahí está el motivo de la llamada."],tip:"Ordena por número de reseñas: un negocio con 200 reseñas tiene dinero para invertir."},{n:"LinkedIn Sales Navigator",q:"Decisores por cargo, tamaño de empresa y sector. Para vender a empresas de más de 20 empleados.",c:"Desde 99 €/mes (prueba gratis de un mes)",pasos:["Filtra por cargo (“Director de marketing”), sector y tamaño (11-50 empleados) y guarda la búsqueda.","Guarda 25 perfiles al día en una lista y mira su actividad reciente para tener un motivo.","Combina con Kaspr o Lusha para sacar el teléfono y llama en vez de escribir por LinkedIn."],tip:"Actívalo solo el mes que vayas a prospectar en serio. Se cancela en dos clics."},{n:"Apollo.io",q:"Base mundial de empresas y contactos con correo, con filtros por tecnología usada y facturación.",c:"Gratis hasta 50 créditos al mes; 49 $/mes el plan básico",pasos:["Crea la cuenta gratuita y usa “Companies” para filtrar país, sector y empleados.","Añade la lista a una secuencia o exporta a CSV (gasta un crédito por contacto revelado).","Verifica los correos con NeverBounce antes de enviar nada."],tip:"Sus teléfonos en España son flojos; para móviles usa Kaspr."},{n:"eInforma / Registro Mercantil",q:"Datos oficiales: facturación, empleados, administrador y fecha de constitución de cualquier sociedad española.",c:"Consultas sueltas desde 3 €; informes completos desde 10 €",pasos:["Busca la empresa por nombre o CIF antes de una reunión importante.","Mira facturación y número de empleados para ajustar tu precio.","Apunta el nombre del administrador: es a quien pides en recepción."],tip:"Las empresas constituidas hace menos de un año son las más abiertas a contratar."}]},{cat:"Correos y teléfonos",icon:"ri-contacts-line",intro:"Con la empresa localizada, falta el dato directo. Estas herramientas lo encuentran y lo verifican.",tools:[{n:"Hunter.io",q:"Encuentra el patrón de correo de una empresa (nombre.apellido@) y verifica direcciones.",c:"Gratis 25 búsquedas al mes; desde 34 €/mes",pasos:["Pega el dominio de la empresa en “Domain search”.","Copia el patrón y aplícalo al nombre del decisor que viste en LinkedIn.","Verifica la dirección con “Email verifier” antes de escribir."],tip:"Si el patrón sale con confianza baja, manda el correo a dos variantes: solo rebota una."},{n:"Kaspr",q:"Extensión de Chrome que saca móvil y correo del perfil de LinkedIn que estás viendo.",c:"Gratis con créditos limitados; desde 45 €/mes",pasos:["Instala la extensión y abre un perfil de LinkedIn.","Pulsa el botón de Kaspr: muestra teléfono y correo si los tiene.","Guarda el contacto en tu lista de To Growth con el móvil y llama."],tip:"Funciona mejor con cargos directivos de empresas medianas que con autónomos."},{n:"NeverBounce",q:"Verifica listas de correos para no quemar tu dominio con rebotes.",c:"Desde 8 $ por 1.000 correos",pasos:["Sube el CSV con la columna de correos.","Descarga solo los marcados como “valid”.","Los “catch-all” envíalos en una tanda aparte y pequeña."],tip:"Más de un 3 % de rebotes en una campaña y Google empieza a mandarte a spam."}]},{cat:"Email en frío",icon:"ri-mail-send-line",intro:"Segunda capa después de la llamada, cuando ya tienes una oferta que funciona y quieres volumen.",tools:[{n:"Instantly",q:"Envío de secuencias con rotación de buzones y calentamiento automático incluido.",c:"Desde 30 $/mes",pasos:["Conecta dos o tres buzones de dominios secundarios (nunca el principal).","Activa el calentamiento y espera tres semanas antes de enviar en frío.","Sube la lista verificada, escribe una secuencia de tres correos y limita a 30 envíos al día por buzón."],tip:"La secuencia entera cabe en 4 líneas por correo. Más largo, menos respuestas."},{n:"Lemlist",q:"Alternativa a Instantly con más personalización (imágenes y vídeos con el nombre del cliente).",c:"Desde 39 €/mes",pasos:["Crea la campaña con variables {{empresa}} y {{dato concreto}}.","Añade una imagen personalizada solo en el primer correo.","Revisa cada mañana las respuestas y llama a quien haya abierto tres veces."],tip:"Con menos de 500 correos al mes no compensa frente a Instantly."},{n:"Google Workspace (dominios secundarios)",q:"Buzones profesionales en dominios parecidos al tuyo para proteger el principal.",c:"6 €/usuario/mes más 10 €/año por dominio",pasos:["Compra dos dominios parecidos (getempresa.com, empresa-contacto.com).","Crea un buzón en cada uno y configura SPF, DKIM y DMARC en el DNS.","Redirige los dominios a tu web principal para que quien los visite te encuentre."],tip:"Nunca envíes en frío desde el dominio con el que facturas."},{n:"MXToolbox",q:"Comprueba gratis que SPF, DKIM y DMARC están bien puestos y si tu dominio está en listas negras.",c:"Gratis",pasos:["Entra en mxtoolbox.com y busca “SuperTool”.","Escribe tu dominio y revisa SPF, DKIM (con el selector) y DMARC.","Repite la comprobación cada mes y después de cualquier cambio de DNS."],tip:"Si sales en una lista negra, para de enviar: primero se limpia, luego se retoma."}]},{cat:"Llamadas y WhatsApp",icon:"ri-phone-line",intro:"Lo que hace que la llamada sea cómoda y quede registrada.",tools:[{n:"Guiones y organizador de To Growth",q:"El guion de cada empresa delante mientras llamas, y el resultado apuntado en el tablero.",c:"Incluido en tu plan",pasos:["Abre la empresa guardada y pulsa “Generar guion” con tu oferta y tu caso de éxito.","Llama con el guion en pantalla: apertura, motivo, dos preguntas, cierre.","Al colgar, mueve la tarjeta a “Contactado”, “Reunión” o “No interesa” y apunta la fecha de seguimiento."],tip:"Bloques de 10 llamadas seguidas sin mirar el móvil. El análisis, al terminar."},{n:"Ringover / Aircall",q:"Número fijo profesional en el ordenador, con grabación y registro automático de llamadas.",c:"Desde 21 €/usuario/mes",pasos:["Contrata un número con prefijo de tu ciudad (cogen más un fijo local que un móvil desconocido).","Activa la grabación y escucha una llamada tuya cada semana para corregir el guion.","Marca desde el ordenador con clic en el número del organizador."],tip:"Un fijo local con prefijo de la ciudad del cliente sube el porcentaje de respuesta."},{n:"WhatsApp Business",q:"Seguimiento después de la llamada y envío de la propuesta con foto o vídeo.",c:"Gratis",pasos:["Crea el perfil con logo, horario y catálogo de servicios.","Guarda respuestas rápidas: confirmación de reunión, propuesta, recordatorio.","Manda el enlace de la reunión justo al colgar, con el día y la hora acordados."],tip:"Nunca abras la conversación por WhatsApp en frío: primero la llamada, luego el mensaje."}]},{cat:"Web y landings",icon:"ri-layout-3-line",intro:"La página cierra lo que la llamada abre. Estas herramientas la levantan sin programar.",tools:[{n:"Framer",q:"Webs y landings con animaciones y buen rendimiento, sin código. La que más rápido queda bonita.",c:"Gratis con subdominio; desde 10 €/mes con dominio propio",pasos:["Empieza desde una plantilla de “servicios” y cambia solo textos, colores y fotos.","Titular con resultado concreto, prueba con cifra y un solo botón a reservar reunión.","Conecta el dominio y activa el formulario o el enlace a tu calendario."],tip:"Una landing de una sola página convierte más que una web de cinco."},{n:"Webflow",q:"Más control y CMS para blogs. Para agencias que hacen webs a clientes.",c:"Desde 14 $/mes por web",pasos:["Diseña con la plantilla en blanco y define las clases una vez.","Crea la colección “Casos de éxito” en el CMS y muéstrala en la portada.","Publica y añade Google Search Console."],tip:"Cobra a tus clientes el alojamiento de Webflow con margen: es ingreso recurrente."},{n:"WordPress + Elementor",q:"El estándar cuando el cliente quiere un blog grande o una tienda.",c:"Alojamiento desde 5 €/mes; Elementor Pro 59 €/año",pasos:["Instala WordPress en el alojamiento y el tema Hello.","Monta la landing con Elementor a partir de una plantilla de servicios.","Instala Rank Math para el SEO básico y un plugin de caché."],tip:"Actualiza plugins una vez al mes o acabará hackeada."},{n:"Carrd",q:"Landing de una página en una hora, por casi nada. Para probar una oferta nueva.",c:"19 $/año",pasos:["Elige una plantilla de una columna.","Titular, tres beneficios, una prueba y el botón a tu calendario.","Publica y manda el enlace después de cada llamada."],tip:"Si en 50 llamadas nadie pide la página, el problema es la oferta, no la web."},{n:"Perfil de Empresa de Google",q:"La ficha que sale en Google Maps. Gratis y es lo primero que mira un cliente local.",c:"Gratis",pasos:["Crea la ficha con categoría exacta, zona de servicio, teléfono y web.","Sube diez fotos reales y pide una reseña a cada cliente contento.","Publica una novedad corta cada dos semanas."],tip:"Ofrécelo como servicio a los negocios que llamas: casi ninguno la tiene bien."}]},{cat:"Reuniones, propuestas y cobro",icon:"ri-calendar-check-line",intro:"Del “sí” al dinero en la cuenta con el menor número de pasos.",tools:[{n:"Google Calendar (citas)",q:"Página de reservas gratuita con Google Meet incluido. Es la que usa To Growth.",c:"Gratis con Google Workspace",pasos:["En Calendar crea una “Página de reservas” de 15 o 30 minutos con tu horario.","Activa Google Meet y el recordatorio por correo el día antes.","Pon el enlace en la web, en la firma y mándalo al colgar."],tip:"Dos opciones de duración, no cinco. Cuantas menos decisiones, más reservas."},{n:"Calendly",q:"Alternativa con más automatizaciones (recordatorios por SMS, preguntas previas).",c:"Gratis un tipo de evento; desde 10 €/mes",pasos:["Crea el evento de 15 minutos con dos preguntas: a quién vendes y cómo consigues clientes hoy.","Activa recordatorio 24 h y 1 h antes.","Integra con Google Meet."],tip:"Las preguntas previas te dan el guion de la reunión hecho."},{n:"Loom",q:"Vídeo de tres minutos con tu pantalla para enviar la propuesta. Cierra más que un PDF.",c:"Gratis hasta 25 vídeos",pasos:["Graba tu pantalla con la web o el problema del cliente delante.","Di qué harías, en qué plazo y cuánto cuesta, sin leer.","Manda el enlace por WhatsApp o correo el mismo día de la reunión."],tip:"Nombra al cliente en los primeros cinco segundos."},{n:"Notion",q:"Propuestas y contratos como páginas compartidas, con seguimiento de cuándo las abren.",c:"Gratis",pasos:["Crea una plantilla de propuesta: problema, solución, alcance, precio, siguiente paso.","Duplica por cliente y comparte el enlace con permiso de solo lectura.","Pon el botón de reservar reunión al final."],tip:"Precio cerrado y una sola opción. Los menús de tres precios retrasan la decisión."},{n:"Stripe o Holded",q:"Cobro con tarjeta y factura automática. Holded además lleva la contabilidad española.",c:"Stripe 1,5 % + 0,25 € por cobro; Holded desde 15 €/mes",pasos:["Crea un enlace de pago con el importe de la propuesta (o el 50 % inicial).","Envíalo dentro de la propuesta y por WhatsApp.","Configura la factura automática al cobrar."],tip:"Cobrar en la misma reunión con un enlace de pago dobla el cierre respecto a “te mando la factura”."}]},{cat:"Anuncios",icon:"ri-advertisement-line",intro:"Solo cuando la oferta ya cierra por teléfono. Los anuncios amplifican lo que funciona, no lo arreglan.",tools:[{n:"Meta Ads (Facebook e Instagram)",q:"Anuncios a dueños de negocio por interés y zona. Para servicios locales y formación.",c:"Desde 10 €/día para probar",pasos:["Campaña de “Clientes potenciales” con formulario instantáneo de tres preguntas.","Un vídeo de 30 segundos tuyo hablando a cámara vale más que un diseño.","Llama a cada contacto en menos de cinco minutos desde que llega."],tip:"Sin llamada en cinco minutos, el contacto de anuncio se enfría y se pierde."},{n:"Google Ads (búsqueda)",q:"Aparecer cuando alguien busca “fotógrafo de producto en Sevilla”. Intención máxima.",c:"Desde 10 €/día",pasos:["Campaña de búsqueda con 5 a 10 palabras exactas de tu servicio y ciudad.","Anuncio con precio o plazo concreto y la landing de una página.","Añade palabras negativas cada semana (“gratis”, “curso”, “empleo”)."],tip:"Una sola ciudad y un solo servicio por campaña."},{n:"Canva",q:"Creativos, propuestas en PDF y portadas para redes sin diseñador.",c:"Gratis; Pro 12 €/mes",pasos:["Crea tu kit de marca (logo, dos colores, una fuente).","Usa las plantillas de “anuncio” y cambia solo el texto por tu resultado concreto.","Exporta en 1080x1080 y 1080x1920."],tip:"Texto grande, una frase, una cara. Lo demás sobra en un anuncio."}]},{cat:"Automatización e IA",icon:"ri-robot-2-line",intro:"Para quitar tareas repetidas cuando ya facturas. Antes de eso, es una distracción.",tools:[{n:"Make",q:"Conecta herramientas entre sí: un formulario nuevo crea una tarjeta, manda un WhatsApp y avisa por correo.",c:"Gratis hasta 1.000 operaciones al mes; desde 9 €/mes",pasos:["Escenario: “Nuevo contacto en formulario” → “Crear fila en hoja” → “Enviar correo de confirmación”.","Prueba con un dato real y revisa el historial de ejecuciones.","Activa y pon una alerta si falla."],tip:"Automatiza solo lo que ya has hecho a mano diez veces."},{n:"Zapier",q:"Lo mismo que Make, más sencillo y más caro. Mejor si la herramienta que necesitas no está en Make.",c:"Gratis 100 tareas al mes; desde 20 €/mes",pasos:["Crea un Zap con el disparador y una acción.","Prueba y publica.","Revisa el consumo de tareas cada mes."],tip:"Dos o tres Zaps sencillos valen más que uno de veinte pasos."},{n:"Claude o ChatGPT",q:"Redactar propuestas, adaptar guiones a un sector y resumir reuniones. Con tu contexto, no en blanco.",c:"Gratis con límites; unos 20 €/mes el plan de pago",pasos:["Pega tu oferta, tu caso de éxito y la web del cliente antes de pedir nada.","Pide “tres motivos concretos para llamar a esta empresa” y elige uno.","Usa el resultado como borrador: la última frase siempre es tuya."],tip:"El generador de guiones de To Growth ya hace esto con tus datos, sin copiar y pegar."},{n:"Clay",q:"Enriquecimiento masivo: sube una lista de empresas y devuelve decisores, correos, tecnologías y datos de la web.",c:"Desde 134 $/mes",pasos:["Importa un CSV de empresas.","Añade columnas de enriquecimiento (decisor, correo, empleados) y una de IA para el motivo de la llamada.","Exporta a tu herramienta de envío."],tip:"Solo compensa a partir de 1.000 empresas al mes. Antes, el buscador y las manos."}]},{cat:"Freelancers y equipo",icon:"ri-team-line",intro:"Cuando la agenda se llena, se delega. Dónde encontrar a quien lo haga bien.",tools:[{n:"Upwork",q:"Freelancers internacionales: setters que llaman por ti, diseñadores, programadores.",c:"Gratis publicar; comisión al pagar",pasos:["Publica la tarea con entregable concreto, plazo y presupuesto cerrado.","Pide un vídeo o audio de 30 segundos a los candidatos de llamadas.","Empieza con una prueba pagada de una semana."],tip:"Un setter que llama en español neutro cobra entre 5 y 9 € la hora."},{n:"Malt",q:"Freelancers en España y Europa con perfil verificado. Para trabajos que necesitan idioma y factura española.",c:"Gratis publicar",pasos:["Busca por habilidad y ciudad y filtra por disponibilidad.","Pide presupuesto a tres y compara plazos, no solo precio.","Firma el alcance en Malt para tener la factura hecha."],tip:"Los perfiles con más de 10 valoraciones responden en el día."},{n:"Fiverr",q:"Tareas cerradas y baratas: edición de vídeo, logo rápido, transcripciones.",c:"Desde 5 €",pasos:["Busca el servicio exacto (“editar vídeo de 3 minutos para Instagram”).","Elige a alguien con más de 100 valoraciones y un ejemplo parecido a lo tuyo.","Manda instrucciones en una lista numerada."],tip:"Para trabajos creativos de verdad, Malt o Upwork. Fiverr, para lo repetitivo."},{n:"Workana",q:"Freelancers de Latinoamérica en español. Buena relación calidad-precio para soporte y llamadas.",c:"Gratis publicar",pasos:["Publica el proyecto con horario en tu zona horaria.","Prueba con dos candidatos una semana cada uno.","Quédate con quien pregunte antes de hacer."],tip:"Especifica la zona horaria: media diferencia horaria es normal, seis horas no."}]}],tarjetaDirectorio(o){return`
            <div class="glass-card module-card directorio-card">
                <div>
                    <div class="flex-between margin-bottom-sm">
                        <span class="badge badge-accent"><i class="ri-tools-line"></i> Solo fundadores</span>
                        <span style="font-size: 12px; color: var(--text-muted);"><i class="ri-apps-fill"></i> ${this.directorio.reduce((n,a)=>n+a.tools.length,0)} herramientas · ${this.directorio.length} categorías</span>
                    </div>
                    <h3>Directorio de herramientas con guía de uso</h3>
                    <p>
                        Todas las herramientas que usamos para encontrar empresas, conseguir el teléfono, llamar, montar la web, cobrar y automatizar.
                        Cada una con para qué sirve, cómo usarla en tres pasos, lo que cuesta y el consejo que te ahorra el error típico.
                    </p>
                </div>
                ${o?'<button type="button" class="btn btn-success btn-block abrirDirectorioBtn"><i class="ri-tools-line"></i> Abrir el directorio</button>':'<button type="button" class="btn btn-outline btn-block openCheckoutBtn"><i class="ri-lock-2-line"></i> Desbloquear con el Plan Fundador</button>'}
            </div>`},tarjetaModulo(o,s,n){const a=this.progresoModulo(o),r=this.estadoModulo(o),l=r.publicados>0,d=s?`<button type="button" class="btn ${l?"btn-primary":"btn-outline"} btn-sm openModuleBtn" data-mod="${o.id}"><i class="${l?"ri-play-circle-line":"ri-file-list-3-line"}"></i> ${l?a>0?a===100?"Repasar":"Continuar":"Empezar":"Ver temario"}</button>`:'<button type="button" class="btn btn-outline btn-sm openCheckoutBtn"><i class="ri-lock-2-line"></i> Desbloquear</button>',c={C:"Vídeo",P:"En pantalla","C+P":"Vídeo + pantalla"};return`
            <details class="modulo-panel"${n?" open":""}>
                <summary>
                    <span class="mp-icono"><i class="${o.icon}"></i>${s?"":'<b class="mp-candado"><i class="ri-lock-2-line"></i></b>'}</span>
                    <span class="mp-texto">
                        <span class="mp-num">${o.number}</span>
                        <h3>${o.title}</h3>
                        <span class="mp-meta">${o.lessons.length} episodios · <span class="mp-estado ${r.clase}">${r.texto}</span>${s&&l?` · ${a}% visto`:""}</span>
                        ${s&&l?`<span class="curso-progreso-barra"><span style="width:${a}%"></span></span>`:""}
                    </span>
                    <span class="mp-accion">${d}</span>
                    <i class="ri-arrow-down-s-line mp-flecha"></i>
                </summary>
                <div class="mp-cuerpo">
                    <p>${o.description}</p>
                    <ul class="curso-temario">
                        ${o.lessons.map(e=>`
                            <li class="${s?"":"leccion-bloqueada"}">
                                <i class="${s?e.video?"ri-play-circle-line":"ri-time-line":"ri-lock-2-line"}"></i>
                                <span>${e.title} <em>· ${e.duration}</em>${e.ia?' <b class="ep-ia">Con IA</b>':""}${e.tipo&&c[e.tipo]?` <b class="ep-tipo">${c[e.tipo]}</b>`:""}</span>
                            </li>`).join("")}
                    </ul>
                </div>
            </details>`},progresoRuta(o){const s=o.reduce((a,r)=>a+r.lessons.length,0);if(!s)return 0;const n=o.reduce((a,r)=>a+Math.round(this.progresoModulo(r)*r.lessons.length/100),0);return Math.round(n/s*100)},renderModulesGrid(){const o=typeof Plan<"u"?Plan.esFundador():!1,s=document.getElementById("academiaLandingGrid"),n=document.getElementById("academiaDashboardGrid"),a=e=>this.modulesData.filter(i=>i.ruta===e.id),r=this.modulesData.reduce((e,i)=>e+i.lessons.length,0),l=this.directorio.reduce((e,i)=>e+i.tools.length,0),d=`
            <div class="academia-resumen">
                <div><b>${this.rutas.filter(e=>e.id!=="bx").length}</b> bloques</div>
                <div><b>${this.modulesData.filter(e=>e.ruta!=="bx").length}</b> módulos</div>
                <div><b>${this.modulesData.filter(e=>e.ruta!=="bx").reduce((e,i)=>e+i.lessons.length,0)}</b> episodios</div>
                <div><b>${this.modulesData.filter(e=>e.ruta==="bx").length}</b> servicios para vender</div>
                <div><b>${l}</b> herramientas con guía</div>
            </div>
            `+this.rutas.map((e,i)=>{const t=a(e),p=t.reduce((m,g)=>m+g.lessons.length,0),u=o?this.progresoRuta(t):0;return`
            <section class="ruta" id="ruta-${e.id}">
                <div class="ruta-cab">
                    <span class="ruta-icono"><i class="${e.icono}"></i></span>
                    <div class="ruta-texto">
                        <span class="ruta-num">${e.etiqueta||"Bloque "+i}</span>
                        <h3>${e.titulo}</h3>
                        <p>${e.descripcion}</p>
                    </div>
                    <div class="ruta-meta">
                        <span>${t.length} ${e.id==="bx"?"servicios":t.length===1?"módulo":"módulos"} · ${p} episodios</span>
                        ${o?`<div class="curso-progreso-barra"><span style="width:${u}%"></span></div><small>${u}%</small>`:""}
                    </div>
                </div>
                <div class="modulos-lista">${t.map((m,g)=>this.tarjetaModulo(m,o,i===0&&g===0)).join("")}</div>
            </section>`}).join("")+`
            <section class="ruta">
                <div class="ruta-cab">
                    <span class="ruta-icono"><i class="ri-tools-line"></i></span>
                    <div class="ruta-texto">
                        <span class="ruta-num">Extra</span>
                        <h3>Directorio de herramientas</h3>
                        <p>Todas las herramientas del sistema con su guía de uso en tres pasos, su coste y el consejo que evita el error típico.</p>
                    </div>
                </div>
                <div class="cursos-grid">${this.tarjetaDirectorio(o)}</div>
            </section>`,c=`
            <div class="acordeon-modulos">
                ${this.rutas.map((e,i)=>{const t=a(e),p=t.reduce((u,m)=>u+m.lessons.length,0);return`
                <details class="modulo-acordeon"${i===0?" open":""}>
                    <summary>
                        <span class="ma-icono"><i class="${e.icono}"></i></span>
                        <span class="ma-texto">
                            <span class="ma-num">${e.etiqueta||"Bloque "+i}</span>
                            <h3>${e.titulo}</h3>
                        </span>
                        <span class="ma-meta">${t.length} ${e.id==="bx"?"servicios":t.length===1?"módulo":"módulos"} · ${p} episodios</span>
                        <i class="ri-arrow-down-s-line ma-flecha"></i>
                    </summary>
                    <div class="ma-cuerpo">
                        <p>${e.descripcion}</p>
                        <ul class="curso-temario">
                            ${t.map(u=>`<li><i class="${u.icon}"></i><span><strong>${u.title}</strong> <em>· ${u.lessons.length} episodios</em><br><span class="ma-desc">${u.description}</span></span></li>`).join("")}
                        </ul>
                    </div>
                </details>`}).join("")}
                <details class="modulo-acordeon directorio-acordeon">
                    <summary>
                        <span class="ma-icono"><i class="ri-tools-line"></i></span>
                        <span class="ma-texto">
                            <span class="ma-num">Extra · solo fundadores</span>
                            <h3>Directorio de herramientas con guía de uso</h3>
                        </span>
                        <span class="ma-meta">${l} herramientas</span>
                        <i class="ri-arrow-down-s-line ma-flecha"></i>
                    </summary>
                    <div class="ma-cuerpo">
                        <p>Todas las herramientas que usamos para encontrar empresas, conseguir el teléfono, llamar, montar la web, cobrar y automatizar. Cada una con para qué sirve, cómo usarla en tres pasos, lo que cuesta y el consejo que evita el error típico.</p>
                        <ul class="curso-temario">
                            ${this.directorio.map(e=>`<li><i class="${e.icon}"></i><span>${e.cat} <em>· ${e.tools.length} herramientas</em></span></li>`).join("")}
                        </ul>
                    </div>
                </details>
            </div>`;s&&(s.innerHTML=c),n&&(n.innerHTML=d),document.querySelectorAll(".openModuleBtn").forEach(e=>{e.onclick=i=>{i.preventDefault(),i.stopPropagation();const t=i.currentTarget.dataset.mod;this.openModuleViewer(t)}}),document.querySelectorAll(".modulo-panel summary .openCheckoutBtn").forEach(e=>{e.addEventListener("click",i=>i.stopPropagation())}),document.querySelectorAll(".abrirDirectorioBtn").forEach(e=>{e.onclick=()=>this.openToolstackModal()})},openModuleViewer(o){const s=this.modulesData.find(a=>a.id===o);if(!s)return;const n=s.lessons[0];this.openLessonViewer(o,n.id)},openLessonViewer(o,s){if(typeof Plan<"u"&&!Plan.esFundador()){Plan.exigir("Los episodios de la Academia son del Plan Fundador.");return}const n=this.modulesData.find(i=>i.id===o);if(!n)return;const a=n.lessons.find(i=>i.id===s);if(!a)return;a.video&&this.marcarLeccionVista(o,a.id);const r=document.getElementById("academyViewerModal");if(!r)return;const l=document.getElementById("academyViewerTitle"),d=document.getElementById("academyViewerBody");l&&(l.textContent=`${n.number}: ${a.title}`);const c=`${o}_${s}`;d.innerHTML=`
            <div style="display: grid; grid-template-columns: 260px 1fr; gap: 20px; min-height: 500px;">
                <!-- SIDEBAR NAVEGACIÓN DE CAPÍTULOS -->
                <div style="background: var(--surface-2); border: 1px solid var(--border-light); padding: 16px; border-radius: 12px;">
                    <h4 style="font-size: 14px; color: var(--accent); margin-bottom: 12px;"><i class="${n.icon}"></i> ${n.number}</h4>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        ${n.lessons.map(i=>`
                            <button class="btn btn-sm ${i.id===s?"btn-primary":"btn-outline"} selectLessonBtn" data-mod="${n.id}" data-les="${i.id}" style="text-align: left; justify-content: flex-start; font-size: 12px;">
                                <i class="${i.video?"ri-play-fill":"ri-time-line"}"></i> ${i.title.split(":")[0]}
                            </button>
                        `).join("")}
                    </div>
                </div>

                <!-- CONTENIDO PRINCIPAL DE LA LECCIÓN -->
                <div>
                    <!-- Reproductor: el vídeo de YouTube si el episodio está publicado.
                         Si no, se dice cuándo llega. Antes había un botón de play
                         de adorno que no reproducía nada. -->
                    ${a.video?`<div class="ep-video"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(a.video)}?rel=0&modestbranding=1" title="${a.title.replace(/"/g,"&quot;")}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`:`<div class="ep-pendiente">
                                <i class="ri-time-line"></i>
                                <h4>${a.title}</h4>
                                <p>${n.disponible?`Este episodio se publica el <strong>${this.fechaLegible(n.disponible)}</strong>.`:"Este episodio todavía no tiene fecha: lo decide la comunidad."} Debajo tienes lo que vas a aprender en él.</p>
                           </div>`}

                    <!-- RESUMEN Y PUNTOS CLAVE -->
                    <div class="glass-card" style="padding: 20px; border-radius: 12px; margin-bottom: 24px;">
                        <h4 style="color: var(--text-main); margin-bottom: 8px;">Qué vas a aprender</h4>
                        <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 16px;">${a.summary}</p>
                        
                        <h5 style="color: var(--accent); margin-bottom: 10px; font-size: 14px;">Al terminar sabrás:</h5>
                        <ul style="list-style: none; padding: 0; margin: 0; font-size: 13px; color: #e2e8f0; display: flex; flex-direction: column; gap: 8px;">
                            ${a.keyTakeaways.map(i=>`<li><i class="ri-checkbox-circle-fill" style="color: var(--success); margin-right: 8px;"></i> ${i}</li>`).join("")}
                        </ul>
                    </div>

                    <!-- SISTEMA DE COMENTARIOS DE ALUMNOS -->
                    <div class="glass-card" style="padding: 20px; border-radius: 12px;">
                        <h4 style="color: var(--text-main); margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
                            <i class="ri-chat-3-line" style="color: var(--primary);"></i> Preguntas y comentarios <span id="lessonCommentsCount"></span>
                        </h4>

                        <!-- FORMULARIO NUEVO COMENTARIO -->
                        <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                            <input type="text" id="newLessonCommentInput" class="form-control" placeholder="Escribe tu duda o comentario sobre este episodio..." style="flex: 1;">
                            <button type="button" id="submitLessonCommentBtn" class="btn btn-primary">
                                <i class="ri-send-plane-fill"></i> Publicar
                            </button>
                        </div>

                        <!-- LISTA DE COMENTARIOS: los trae Academy.cargarComentarios desde Supabase -->
                        <div id="lessonCommentsList" style="display: flex; flex-direction: column; gap: 12px;">
                            <p class="text-muted" style="font-size:13px;">Cargando comentarios…</p>
                        </div>
                    </div>
                </div>
            </div>
        `,r.classList.remove("hidden"),this.cargarComentarios(c),d.querySelectorAll(".selectLessonBtn").forEach(i=>{i.onclick=t=>{const p=t.currentTarget.dataset.mod,u=t.currentTarget.dataset.les;this.openLessonViewer(p,u)}});const e=document.getElementById("submitLessonCommentBtn");e&&(e.onclick=async()=>{const i=document.getElementById("newLessonCommentInput"),t=i?i.value.trim():"";if(!t)return;e.disabled=!0;const p=await this.publicarComentario(c,t);e.disabled=!1,p&&(i.value="",this.cargarComentarios(c),typeof App<"u"&&App.showToast&&App.showToast("Comentario publicado.","success"))})},openToolstackModal(){if(typeof Plan<"u"&&!Plan.esFundador()){Plan.exigir("El directorio de herramientas es del Plan Fundador.");return}const o=document.getElementById("academyViewerModal"),s=document.getElementById("academyViewerTitle"),n=document.getElementById("academyViewerBody");if(!o||!s||!n)return;const a=l=>String(l??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),r=this.directorio.reduce((l,d)=>l+d.tools.length,0);s.textContent=`Directorio de herramientas (${r})`,n.innerHTML=`
            <div class="directorio">
                <p class="directorio-intro">
                    Ordenado por el orden en que se usan: primero la lista, luego el dato, luego la llamada, y solo al final anuncios y automatización.
                    Abre una categoría y dentro cada herramienta lleva su guía en tres pasos.
                </p>
                ${this.directorio.map((l,d)=>`
                <details class="directorio-cat"${d===0?" open":""}>
                    <summary>
                        <i class="${l.icon}"></i>
                        <span class="dc-titulo">${a(l.cat)}</span>
                        <span class="dc-meta">${l.tools.length}</span>
                        <i class="ri-arrow-down-s-line dc-flecha"></i>
                    </summary>
                    <p class="dc-intro">${a(l.intro)}</p>
                    <div class="dc-lista">
                        ${l.tools.map(c=>`
                        <details class="herramienta">
                            <summary>
                                <span class="h-nombre">${a(c.n)}</span>
                                <span class="h-coste">${a(c.c)}</span>
                                <i class="ri-arrow-down-s-line dc-flecha"></i>
                            </summary>
                            <div class="h-cuerpo">
                                <p class="h-que">${a(c.q)}</p>
                                <div class="h-etiqueta">Cómo usarla</div>
                                <ol class="h-pasos">${c.pasos.map(e=>`<li>${a(e)}</li>`).join("")}</ol>
                                <p class="h-tip"><i class="ri-lightbulb-flash-line"></i> ${a(c.tip)}</p>
                            </div>
                        </details>`).join("")}
                    </div>
                </details>`).join("")}
            </div>
        `,o.classList.remove("hidden")}};document.addEventListener("DOMContentLoaded",()=>{Academy.init()}),document.addEventListener("click",o=>{const s=o.target.closest(".subtab");if(!s)return;const n=s.dataset.sub;n&&(document.querySelectorAll(".subtab").forEach(a=>{const r=a===s;a.classList.toggle("activa",r),a.setAttribute("aria-selected",r?"true":"false")}),document.querySelectorAll(".subtab-pane").forEach(a=>{a.classList.toggle("hidden",a.id!==n)}),n==="subComunidad"&&typeof Community<"u"&&Community.renderCommunityTab&&Community.renderCommunityTab())}),window.Academy=Academy;
