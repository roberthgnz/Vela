const Plan={esFundador(){return typeof window.checkIsVIP=="function"?window.checkIsVIP():localStorage.getItem("to_growth_is_vip")==="true"},bloqueo({titulo:e,descripcion:t,icono:n="ri-lock-2-line",compacto:o=!1}){return`
            <div class="bloqueo-fundador${o?" compacto":""}">
                <div class="bloqueo-icono"><i class="${n}"></i></div>
                <h3>${e}</h3>
                <p>${t}</p>
                <button class="btn btn-primary openCheckoutBtn">
                    <i class="ri-flashlight-line"></i> Desbloquear con el Plan Fundador
                </button>
            </div>
        `},pintarMenu(e){const t=this.esFundador(),n=document.getElementById("sbPlanCard"),o=document.getElementById("sbPlanOk"),i=document.querySelector(".sidebar-admin");n&&(n.hidden=t),o&&(o.hidden=!t),i&&(i.hidden=!e)},exigir(e){return this.esFundador()?!0:(typeof App<"u"&&App.showToast&&App.showToast(e||"Esto forma parte del Plan Fundador.","warning"),typeof Checkout<"u"&&Checkout.startCheckout&&Checkout.startCheckout(),!1)}};window.Plan=Plan;
