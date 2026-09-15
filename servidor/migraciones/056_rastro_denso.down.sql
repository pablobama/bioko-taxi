-- Vuelve a los valores de la migración 042. Lo que la purga ya borró con 45
-- días no vuelve: esto solo cambia lo que se guarde y se borre a partir de aquí.
UPDATE parametro SET valor = '45' WHERE clave = 'rastro_intervalo_min_seg';
UPDATE parametro SET valor = '90' WHERE clave = 'rastro_retencion_dias';
