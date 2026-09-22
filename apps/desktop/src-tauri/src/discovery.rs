//! Anuncio mDNS del servicio `_p2pclip._tcp.local.` para que el móvil nos descubra en la LAN.

use mdns_sd::{ServiceDaemon, ServiceInfo};

use crate::protocol::{MDNS_FULL_SERVICE_TYPE, PROTOCOL_VERSION};

pub fn advertise(port: u16) -> Result<ServiceDaemon, mdns_sd::Error> {
    let daemon = ServiceDaemon::new()?;

    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "portapapeles-desktop".to_string());
    let instance_name = format!("{hostname}-{port}");
    let host_fqdn = format!("{hostname}.local.");

    // "" + enable_addr_auto(): mdns-sd detecta y mantiene actualizadas las IPs
    // de las interfaces de red del host, sin que tengamos que enumerarlas a mano.
    let properties = [("protocolVersion", PROTOCOL_VERSION)];
    let service_info = ServiceInfo::new(
        MDNS_FULL_SERVICE_TYPE,
        &instance_name,
        &host_fqdn,
        "",
        port,
        &properties[..],
    )
    .expect("ServiceInfo::new con parámetros válidos no debería fallar")
    .enable_addr_auto();

    daemon.register(service_info)?;

    println!(
        "[mDNS] Servicio anunciado: {} como \"{}\" en el puerto {}",
        MDNS_FULL_SERVICE_TYPE, instance_name, port
    );

    Ok(daemon)
}
