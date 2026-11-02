(function(){"use strict";const t=document.querySelector(".video-hero"),i=t&&t.querySelector("video");if(!t||!i)return;const l=window.matchMedia("(prefers-reduced-motion: reduce)").matches;function d(){const e=document.createElement("div");return e.className="intro-logo",e.setAttribute("aria-hidden","true"),e.innerHTML=`
            <div class="intro-logo-escena">
                <svg class="intro-logo-svg" viewBox="0 0 64 64" width="120" height="120">
                    <defs>
                        <clipPath id="il-a"><circle cx="32" cy="22" r="17"/></clipPath>
                        <clipPath id="il-b" clip-path="url(#il-a)"><circle cx="22" cy="40" r="17"/></clipPath>
                    </defs>
                    <circle class="il-c il-c1" cx="32" cy="22" r="17" fill="#7FB0FF" opacity=".9"/>
                    <circle class="il-c il-c2" cx="22" cy="40" r="17" fill="#3D7BFF" opacity=".9"/>
                    <circle class="il-c il-c3" cx="42" cy="40" r="17" fill="#2457D6" opacity=".9"/>
                    <circle class="il-core" cx="42" cy="40" r="17" fill="#FFFFFF" clip-path="url(#il-b)"/>
                </svg>
                <div class="intro-logo-nombre">To <span>Growth</span></div>
                <div class="intro-logo-lema">Software · Academia · Agencia</div>
            </div>`,t.appendChild(e),e}function o(){if(window.cargarVideoPortada&&!i.getAttribute("src")){window.cargarVideoPortada();return}try{const e=i.play();e&&e.catch&&e.catch(function(){})}catch{}}function c(){if(l||t.querySelector(".intro-logo")){o();return}i.pause();const e=d();requestAnimationFrame(function(){requestAnimationFrame(function(){e.classList.add("activa")})}),setTimeout(o,1900),setTimeout(function(){e.classList.add("fuera")},2100),setTimeout(function(){e.remove()},3e3)}function n(){if("IntersectionObserver"in window){const e=new IntersectionObserver(function(u){u.some(function(f){return f.isIntersecting})&&(e.disconnect(),c())},{threshold:.35});e.observe(t)}else c()}const r=["pointermove","pointerdown","touchstart","scroll","keydown","wheel"];function a(){r.forEach(function(e){window.removeEventListener(e,a,!0)}),document.readyState==="complete"?n():window.addEventListener("load",n,{once:!0})}r.forEach(function(e){window.addEventListener(e,a,{capture:!0,passive:!0})});const s=document.getElementById("logoBtn");s&&s.addEventListener("click",function(){const e=t.querySelector(".intro-logo");e&&e.remove(),setTimeout(c,150)})})();
