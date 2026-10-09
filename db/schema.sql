-- =====================================================================
-- SUCE - Schema para Neon (Postgres) + PostgREST
-- Fichas 100% virtuales, sin valor monetario real, sin compra ni canje.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extensiones necesarias
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto; -- para gen_random_uuid() y crypt()
create extension if not exists pgjwt;    -- para firmar tokens JWT desde SQL

-- ---------------------------------------------------------------------
-- ESQUEMAS: separamos el "api" público (lo que expone PostgREST)
-- de los datos internos.
-- ---------------------------------------------------------------------
create schema if not exists app;      -- tablas de datos
create schema if not exists api;      -- vistas/funciones expuestas por PostgREST

-- ---------------------------------------------------------------------
-- ROLES para PostgREST (JWT)
--   anon        -> sin sesión (solo login)
--   jugador     -> usuario normal autenticado
--   admin       -> vos, el administrador
-- ---------------------------------------------------------------------
create role anon nologin;
create role jugador nologin;
create role admin_role nologin;
create role authenticator noinherit login password 'CAMBIAR_ESTA_PASSWORD';
grant anon, jugador, admin_role to authenticator;

-- ---------------------------------------------------------------------
-- TABLA: usuarios
-- ---------------------------------------------------------------------
create table app.usuarios (
    id            uuid primary key default gen_random_uuid(),
    username      text unique not null,
    password_hash text not null,               -- hash bcrypt/argon2, nunca texto plano
    rol           text not null default 'jugador' check (rol in ('jugador','admin')),
    activo        boolean not null default true,
    creado_en     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- TABLA: wallets (saldo de fichas por usuario)
-- ---------------------------------------------------------------------
create table app.wallets (
    usuario_id  uuid primary key references app.usuarios(id) on delete cascade,
    saldo       bigint not null default 0 check (saldo >= 0),
    actualizado_en timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- TABLA: transacciones (auditoría de cada movimiento de fichas)
--   tipo: 'carga_admin', 'apuesta', 'premio', 'ajuste'
-- ---------------------------------------------------------------------
create table app.transacciones (
    id            bigserial primary key,
    usuario_id    uuid not null references app.usuarios(id),
    tipo          text not null check (tipo in ('carga_admin','apuesta','premio','ajuste')),
    monto         bigint not null,  -- positivo = suma, negativo = resta
    saldo_resultante bigint not null,
    referencia    text,             -- ej: id de la partida, o admin que cargó
    creado_en     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- TABLA: catálogo de juegos
-- ---------------------------------------------------------------------
create table app.juegos (
    id          text primary key,      -- slug: 'tragamonedas', 'ruleta', etc.
    nombre      text not null,
    activo      boolean not null default true,
    apuesta_min bigint not null default 10,
    apuesta_max bigint not null default 1000
);

-- ---------------------------------------------------------------------
-- TABLA: historial de partidas jugadas
-- ---------------------------------------------------------------------
create table app.partidas (
    id          bigserial primary key,
    usuario_id  uuid not null references app.usuarios(id),
    juego_id    text not null references app.juegos(id),
    apuesta     bigint not null,
    resultado   jsonb not null,    -- detalle específico del juego (números, cartas, etc.)
    ganancia    bigint not null,   -- fichas ganadas (0 si perdió)
    creado_en   timestamptz not null default now()
);

-- =====================================================================
-- FUNCIONES DE NEGOCIO (SECURITY DEFINER = corren con permisos elevados
-- pero validan todo internamente; esto es lo que expone PostgREST vía RPC)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Devuelve el usuario actual a partir del JWT (claim "sub")
-- ---------------------------------------------------------------------
create or replace function app.usuario_actual()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;

create or replace function app.rol_actual()
returns text
language sql stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::json->>'rol', 'anon')
$$;

-- ---------------------------------------------------------------------
-- ADMIN: crear usuario jugador
-- ---------------------------------------------------------------------
create or replace function api.admin_crear_usuario(p_username text, p_password text)
returns uuid
language plpgsql security definer
as $$
declare
  v_id uuid;
begin
  if app.rol_actual() <> 'admin' then
    raise exception 'No autorizado';
  end if;

  insert into app.usuarios (username, password_hash, rol)
  values (p_username, crypt(p_password, gen_salt('bf')), 'jugador')
  returning id into v_id;

  insert into app.wallets (usuario_id, saldo) values (v_id, 0);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- ADMIN: cargar fichas a un jugador
-- ---------------------------------------------------------------------
create or replace function api.admin_cargar_fichas(p_usuario_id uuid, p_monto bigint)
returns bigint
language plpgsql security definer
as $$
declare
  v_nuevo_saldo bigint;
begin
  if app.rol_actual() <> 'admin' then
    raise exception 'No autorizado';
  end if;
  if p_monto <= 0 then
    raise exception 'El monto debe ser positivo';
  end if;

  update app.wallets
     set saldo = saldo + p_monto, actualizado_en = now()
   where usuario_id = p_usuario_id
   returning saldo into v_nuevo_saldo;

  insert into app.transacciones (usuario_id, tipo, monto, saldo_resultante, referencia)
  values (p_usuario_id, 'carga_admin', p_monto, v_nuevo_saldo, app.usuario_actual()::text);

  return v_nuevo_saldo;
end;
$$;

-- ---------------------------------------------------------------------
-- JUGADOR: obtener mi saldo
-- ---------------------------------------------------------------------
create or replace function api.mi_saldo()
returns bigint
language sql security definer
as $$
  select saldo from app.wallets where usuario_id = app.usuario_actual()
$$;

-- ---------------------------------------------------------------------
-- JUGADOR: jugar una partida (genérico para cualquier juego)
--   p_resultado y p_ganancia los calcula la función específica de cada
--   juego (ver ejemplo tragamonedas más abajo); esta función central
--   se encarga de mover las fichas de forma atómica y auditada.
-- ---------------------------------------------------------------------
create or replace function app.registrar_partida(
  p_juego_id text, p_apuesta bigint, p_resultado jsonb, p_ganancia bigint
) returns jsonb
language plpgsql security definer
as $$
declare
  v_usuario uuid := app.usuario_actual();
  v_saldo bigint;
begin
  if v_usuario is null then
    raise exception 'No autenticado';
  end if;

  select saldo into v_saldo from app.wallets where usuario_id = v_usuario for update;

  if v_saldo < p_apuesta then
    raise exception 'Saldo insuficiente';
  end if;

  -- Descuenta la apuesta
  update app.wallets set saldo = saldo - p_apuesta, actualizado_en = now()
   where usuario_id = v_usuario;
  insert into app.transacciones (usuario_id, tipo, monto, saldo_resultante, referencia)
  values (v_usuario, 'apuesta', -p_apuesta, v_saldo - p_apuesta, p_juego_id);

  -- Suma el premio si ganó
  if p_ganancia > 0 then
    update app.wallets set saldo = saldo + p_ganancia, actualizado_en = now()
     where usuario_id = v_usuario;
    insert into app.transacciones (usuario_id, tipo, monto, saldo_resultante, referencia)
    values (v_usuario, 'premio', p_ganancia, v_saldo - p_apuesta + p_ganancia, p_juego_id);
  end if;

  insert into app.partidas (usuario_id, juego_id, apuesta, resultado, ganancia)
  values (v_usuario, p_juego_id, p_apuesta, p_resultado, p_ganancia);

  select saldo into v_saldo from app.wallets where usuario_id = v_usuario;

  return jsonb_build_object('saldo_nuevo', v_saldo, 'ganancia', p_ganancia, 'resultado', p_resultado);
end;
$$;

-- =====================================================================
-- LOGIN: verifica usuario/contraseña y devuelve un JWT
-- El secreto DEBE ser el mismo que pongas en jwt-secret de postgrest.conf
-- =====================================================================
create or replace function api.login(p_username text, p_password text)
returns jsonb
language plpgsql security definer
as $$
declare
  v_usuario app.usuarios;
  v_token text;
begin
  select * into v_usuario from app.usuarios
   where username = p_username and activo = true;

  if not found or v_usuario.password_hash <> crypt(p_password, v_usuario.password_hash) then
    raise exception 'Usuario o contraseña incorrectos';
  end if;

  select sign(
    row_to_json(r)::json,
    'CAMBIAR_POR_UN_SECRETO_LARGO_Y_RANDOM_DE_AL_MENOS_32_CARACTERES' -- igual al jwt-secret
  ) into v_token
  from (
    select
      v_usuario.rol::text as rol,
      v_usuario.id::text as sub,
      v_usuario.username as username,
      extract(epoch from now() + interval '12 hours')::int as exp
  ) r;

  return jsonb_build_object('token', v_token, 'rol', v_usuario.rol, 'username', v_usuario.username);
end;
$$;

grant execute on function api.login(text, text) to anon;

-- Helper para crear el primer usuario admin a mano (correr una sola vez):
-- insert into app.usuarios (username, password_hash, rol)
-- values ('admin', crypt('TU_PASSWORD_SEGURA', gen_salt('bf')), 'admin');
-- insert into app.wallets (usuario_id, saldo)
-- select id, 0 from app.usuarios where username = 'admin';

-- =====================================================================
-- ACTIVIDAD RECIENTE: últimas ganancias reales, para mostrar "vida" en
-- la landing pública (solo usuario, juego y monto — nada sensible)
-- =====================================================================
create or replace function api.actividad_reciente()
returns table(username text, juego_id text, ganancia bigint, creado_en timestamptz)
language sql security definer
as $$
  select u.username, p.juego_id, p.ganancia, p.creado_en
  from app.partidas p
  join app.usuarios u on u.id = p.usuario_id
  where p.ganancia > 0
  order by p.creado_en desc
  limit 8
$$;

grant execute on function api.actividad_reciente() to anon, jugador, admin_role;

-- =====================================================================
-- MESAS PVP EN VIVO (1 vs 1, fichas virtuales) — Carta Más Alta
-- Funciona por "polling": el navegador consulta el estado cada 2-3 seg.
-- =====================================================================
create table app.mesas_pvp (
  id             bigserial primary key,
  juego          text not null default 'carta_alta_pvp',
  creador_id     uuid not null references app.usuarios(id),
  oponente_id    uuid references app.usuarios(id),
  apuesta        bigint not null check (apuesta > 0),
  estado         text not null default 'esperando' check (estado in ('esperando','terminada','cancelada')),
  carta_creador  int,
  carta_oponente int,
  ganador_id     uuid references app.usuarios(id),
  creado_en      timestamptz not null default now()
);

-- Genera un valor random según el tipo de juego en vivo (mayor valor gana)
create or replace function app.pvp_valor_random(p_juego text)
returns int language sql as $$
  select case p_juego
    when 'carta_alta'    then 1 + floor(random()*13)::int        -- 1 a 13
    when 'dado_simple'   then 1 + floor(random()*6)::int          -- 1 a 6
    when 'dados_dobles'  then (1+floor(random()*6)::int) + (1+floor(random()*6)::int) -- 2 a 12
    when 'numero_suerte' then 1 + floor(random()*100)::int        -- 1 a 100
    when 'ruleta_pvp'    then floor(random()*37)::int             -- 0 a 36
    else null
  end
$$;

-- Helper interno: ajusta el saldo de un usuario y deja auditoría
create or replace function app.ajustar_saldo(p_usuario_id uuid, p_monto bigint, p_tipo text, p_referencia text)
returns bigint language plpgsql security definer as $$
declare v_saldo bigint;
begin
  select saldo into v_saldo from app.wallets where usuario_id = p_usuario_id for update;
  if v_saldo + p_monto < 0 then
    raise exception 'Saldo insuficiente';
  end if;
  update app.wallets set saldo = saldo + p_monto, actualizado_en = now() where usuario_id = p_usuario_id;
  insert into app.transacciones (usuario_id, tipo, monto, saldo_resultante, referencia)
  values (p_usuario_id, p_tipo, p_monto, v_saldo + p_monto, p_referencia);
  return v_saldo + p_monto;
end; $$;

-- Crear una mesa (se descuenta la apuesta al instante)
create or replace function api.pvp_crear_mesa(p_apuesta bigint, p_juego text default 'carta_alta')
returns bigint language plpgsql security definer as $$
declare v_usuario uuid := app.usuario_actual(); v_mesa_id bigint;
begin
  if v_usuario is null then raise exception 'No autenticado'; end if;
  if p_apuesta < 10 then raise exception 'La apuesta mínima es 10 fichas'; end if;
  if p_juego not in ('carta_alta','dado_simple','dados_dobles','numero_suerte','ruleta_pvp') then
    raise exception 'Tipo de juego en vivo inválido';
  end if;

  perform app.ajustar_saldo(v_usuario, -p_apuesta, 'apuesta', 'pvp_crear');

  insert into app.mesas_pvp (creador_id, apuesta, juego) values (v_usuario, p_apuesta, p_juego)
  returning id into v_mesa_id;

  return v_mesa_id;
end; $$;
grant execute on function api.pvp_crear_mesa(bigint, text) to jugador;

-- Listar mesas esperando oponente para un juego específico (no las tuyas propias)
create or replace function api.pvp_mesas_disponibles(p_juego text default 'carta_alta')
returns table(id bigint, creador_username text, apuesta bigint, creado_en timestamptz)
language sql security definer as $$
  select m.id, u.username, m.apuesta, m.creado_en
  from app.mesas_pvp m
  join app.usuarios u on u.id = m.creador_id
  where m.estado = 'esperando' and m.creador_id <> app.usuario_actual() and m.juego = p_juego
  order by m.creado_en desc
  limit 20
$$;
grant execute on function api.pvp_mesas_disponibles(text) to jugador;

-- Unirse a una mesa: resuelve la partida al instante (reparte cartas y paga)
create or replace function api.pvp_unirse_mesa(p_mesa_id bigint)
returns jsonb language plpgsql security definer as $$
declare
  v_usuario uuid := app.usuario_actual();
  v_mesa app.mesas_pvp;
  v_carta_a int; v_carta_b int; v_ganador uuid; v_premio bigint;
begin
  if v_usuario is null then raise exception 'No autenticado'; end if;

  select * into v_mesa from app.mesas_pvp where id = p_mesa_id for update;
  if not found or v_mesa.estado <> 'esperando' then
    raise exception 'Esta mesa ya no está disponible';
  end if;
  if v_mesa.creador_id = v_usuario then
    raise exception 'No podés unirte a tu propia mesa';
  end if;

  perform app.ajustar_saldo(v_usuario, -v_mesa.apuesta, 'apuesta', 'pvp_unirse');

  v_carta_a := app.pvp_valor_random(v_mesa.juego);
  v_carta_b := app.pvp_valor_random(v_mesa.juego);

  if v_carta_a > v_carta_b then
    v_ganador := v_mesa.creador_id;
  elsif v_carta_b > v_carta_a then
    v_ganador := v_usuario;
  else
    v_ganador := null; -- empate: se devuelve la apuesta a ambos
  end if;

  if v_ganador is not null then
    v_premio := round(v_mesa.apuesta * 1.9); -- margen de casa ~5% sobre el pozo
    perform app.ajustar_saldo(v_ganador, v_premio, 'premio', 'pvp_resultado');
  else
    perform app.ajustar_saldo(v_mesa.creador_id, v_mesa.apuesta, 'ajuste', 'pvp_empate');
    perform app.ajustar_saldo(v_usuario, v_mesa.apuesta, 'ajuste', 'pvp_empate');
  end if;

  update app.mesas_pvp
     set oponente_id = v_usuario, estado = 'terminada',
         carta_creador = v_carta_a, carta_oponente = v_carta_b, ganador_id = v_ganador
   where id = p_mesa_id;

  return jsonb_build_object(
    'carta_creador', v_carta_a, 'carta_oponente', v_carta_b,
    'ganador_id', v_ganador, 'yo_gane', (v_ganador = v_usuario)
  );
end; $$;
grant execute on function api.pvp_unirse_mesa(bigint) to jugador;

-- Consultar el estado de una mesa propia (para que el creador haga "polling")
create or replace function api.pvp_estado_mesa(p_mesa_id bigint)
returns jsonb language plpgsql security definer as $$
declare v_usuario uuid := app.usuario_actual(); v_mesa app.mesas_pvp; v_oponente_username text;
begin
  select * into v_mesa from app.mesas_pvp where id = p_mesa_id;
  if not found or (v_mesa.creador_id <> v_usuario and v_mesa.oponente_id <> v_usuario) then
    raise exception 'Mesa no encontrada';
  end if;

  if v_mesa.oponente_id is not null then
    select username into v_oponente_username from app.usuarios where id = v_mesa.oponente_id;
  end if;

  return jsonb_build_object(
    'estado', v_mesa.estado,
    'apuesta', v_mesa.apuesta,
    'oponente_username', v_oponente_username,
    'carta_creador', v_mesa.carta_creador,
    'carta_oponente', v_mesa.carta_oponente,
    'yo_gane', (v_mesa.ganador_id = v_usuario),
    'hubo_empate', (v_mesa.estado = 'terminada' and v_mesa.ganador_id is null)
  );
end; $$;
grant execute on function api.pvp_estado_mesa(bigint) to jugador;

-- Cancelar una mesa propia que sigue esperando (devuelve la apuesta)
create or replace function api.pvp_cancelar_mesa(p_mesa_id bigint)
returns void language plpgsql security definer as $$
declare v_usuario uuid := app.usuario_actual(); v_mesa app.mesas_pvp;
begin
  select * into v_mesa from app.mesas_pvp where id = p_mesa_id for update;
  if not found or v_mesa.creador_id <> v_usuario or v_mesa.estado <> 'esperando' then
    raise exception 'No se puede cancelar esta mesa';
  end if;
  perform app.ajustar_saldo(v_usuario, v_mesa.apuesta, 'ajuste', 'pvp_cancelada');
  update app.mesas_pvp set estado = 'cancelada' where id = p_mesa_id;
end; $$;
grant execute on function api.pvp_cancelar_mesa(bigint) to jugador;

-- =====================================================================
-- RANKING: top jugadores por fichas ganadas acumuladas (solo virtual)
-- =====================================================================
create or replace function api.ranking_jugadores()
returns table(username text, total_ganado bigint)
language sql security definer
as $$
  select u.username, coalesce(sum(p.ganancia), 0)::bigint as total_ganado
  from app.usuarios u
  join app.partidas p on p.usuario_id = u.id
  where u.rol = 'jugador'
  group by u.username
  order by total_ganado desc
  limit 10
$$;

grant execute on function api.ranking_jugadores() to anon, jugador, admin_role;

-- =====================================================================
-- JUEGO: Cara o Cruz (moneda) — margen de casa ~5%
-- =====================================================================
create or replace function api.jugar_moneda(p_apuesta bigint, p_eleccion text)
returns jsonb language plpgsql security definer as $$
declare v_resultado text; v_gano boolean; v_ganancia bigint := 0; v_out jsonb;
begin
  if p_eleccion not in ('cara','cruz') then raise exception 'Elección inválida'; end if;
  v_resultado := case when random() < 0.5 then 'cara' else 'cruz' end;
  v_gano := (v_resultado = p_eleccion);
  if v_gano then v_ganancia := round(p_apuesta * 1.9); end if;
  v_out := jsonb_build_object('resultado', v_resultado, 'gano', v_gano);
  return app.registrar_partida('moneda', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_moneda(bigint, text) to jugador;

-- =====================================================================
-- JUEGO: Dados — apostá a que la suma sea alta (8-12) o baja (2-6).
-- El 7 siempre es a favor de la casa (como en craps real).
-- =====================================================================
create or replace function api.jugar_dados(p_apuesta bigint, p_eleccion text)
returns jsonb language plpgsql security definer as $$
declare d1 int; d2 int; suma int; v_ganancia bigint := 0; v_out jsonb;
begin
  if p_eleccion not in ('alto','bajo') then raise exception 'Elección inválida'; end if;
  d1 := 1 + floor(random()*6)::int;
  d2 := 1 + floor(random()*6)::int;
  suma := d1 + d2;
  if suma <> 7 then
    if (p_eleccion = 'alto' and suma >= 8) or (p_eleccion = 'bajo' and suma <= 6) then
      v_ganancia := round(p_apuesta * 2.2);
    end if;
  end if;
  v_out := jsonb_build_object('dado1', d1, 'dado2', d2, 'suma', suma);
  return app.registrar_partida('dados', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_dados(bigint, text) to jugador;

-- =====================================================================
-- JUEGO: Alto o Bajo (Hi-Lo con cartas 1-13)
-- =====================================================================
create or replace function api.jugar_hilo(p_apuesta bigint, p_eleccion text)
returns jsonb language plpgsql security definer as $$
declare carta_actual int; carta_nueva int; v_ganancia bigint := 0; v_out jsonb;
begin
  if p_eleccion not in ('alto','bajo') then raise exception 'Elección inválida'; end if;
  carta_actual := 1 + floor(random()*13)::int;
  carta_nueva := 1 + floor(random()*13)::int;
  if (p_eleccion = 'alto' and carta_nueva > carta_actual)
     or (p_eleccion = 'bajo' and carta_nueva < carta_actual) then
    v_ganancia := round(p_apuesta * 1.9);
  end if;
  v_out := jsonb_build_object('carta_actual', carta_actual, 'carta_nueva', carta_nueva);
  return app.registrar_partida('hilo', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_hilo(bigint, text) to jugador;

-- =====================================================================
-- JUEGO: Carta Más Alta — tu carta vs. la carta de la casa
-- =====================================================================
create or replace function api.jugar_carta_alta(p_apuesta bigint)
returns jsonb language plpgsql security definer as $$
declare carta_jugador int; carta_casa int; v_ganancia bigint := 0; v_out jsonb;
begin
  carta_jugador := 1 + floor(random()*13)::int;
  carta_casa := 1 + floor(random()*13)::int;
  if carta_jugador > carta_casa then
    v_ganancia := round(p_apuesta * 1.9);
  end if;
  v_out := jsonb_build_object('carta_jugador', carta_jugador, 'carta_casa', carta_casa);
  return app.registrar_partida('carta_alta', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_carta_alta(bigint) to jugador;

-- =====================================================================
-- JUEGO: Ruleta — apuesta a número exacto (x34) o a color (x1.9)
-- =====================================================================
create or replace function api.jugar_ruleta(p_apuesta bigint, p_tipo text, p_valor text)
returns jsonb language plpgsql security definer as $$
declare
  numero int;
  color text;
  v_ganancia bigint := 0;
  v_out jsonb;
  rojos int[] := array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
begin
  numero := floor(random()*37)::int; -- 0 a 36
  color := case when numero = 0 then 'verde'
                when numero = any(rojos) then 'rojo'
                else 'negro' end;

  if p_tipo = 'numero' then
    if numero::text = p_valor then v_ganancia := p_apuesta * 34; end if;
  elsif p_tipo = 'color' then
    if color = p_valor then v_ganancia := round(p_apuesta * 1.9); end if;
  else
    raise exception 'Tipo de apuesta inválido';
  end if;

  v_out := jsonb_build_object('numero', numero, 'color', color);
  return app.registrar_partida('ruleta', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_ruleta(bigint, text, text) to jugador;

-- =====================================================================
-- JUEGO: Keno — elegís 1 número (1-40), se sortean 10
-- =====================================================================
create or replace function api.jugar_keno(p_apuesta bigint, p_numero int)
returns jsonb language plpgsql security definer as $$
declare sorteados int[]; v_ganancia bigint := 0; v_out jsonb;
begin
  if p_numero < 1 or p_numero > 40 then raise exception 'Número fuera de rango (1-40)'; end if;

  select array_agg(x) into sorteados
  from (select generate_series(1,40) as x order by random() limit 10) s;

  if p_numero = any(sorteados) then
    v_ganancia := round(p_apuesta * 3.8);
  end if;

  v_out := jsonb_build_object('sorteados', sorteados);
  return app.registrar_partida('keno', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_keno(bigint, int) to jugador;

-- =====================================================================
-- JUEGO: Rasca y Gana — 3 símbolos, revelado instantáneo
-- =====================================================================
create or replace function api.jugar_rasca(p_apuesta bigint)
returns jsonb language plpgsql security definer as $$
declare
  simbolos text[] := array['💎','🍀','🔔','⭐','👑'];
  r1 text; r2 text; r3 text; v_ganancia bigint := 0; v_out jsonb;
begin
  r1 := simbolos[1 + floor(random()*5)::int];
  r2 := simbolos[1 + floor(random()*5)::int];
  r3 := simbolos[1 + floor(random()*5)::int];

  if r1 = r2 and r2 = r3 then
    v_ganancia := p_apuesta * (case r1 when '👑' then 12 when '💎' then 8 else 4 end);
  elsif r1 = r2 or r2 = r3 or r1 = r3 then
    v_ganancia := p_apuesta;
  end if;

  v_out := jsonb_build_object('simbolos', jsonb_build_array(r1, r2, r3));
  return app.registrar_partida('rasca', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_rasca(bigint) to jugador;

-- =====================================================================
-- JUEGO: Rueda de la Suerte — margen de casa ~6%
-- =====================================================================
create or replace function api.jugar_rueda(p_apuesta bigint)
returns jsonb language plpgsql security definer as $$
declare r float := random(); multiplicador numeric; v_ganancia bigint; v_out jsonb;
begin
  if     r < 0.45  then multiplicador := 0;
  elsif  r < 0.70  then multiplicador := 1;
  elsif  r < 0.85  then multiplicador := 1.5;
  elsif  r < 0.94  then multiplicador := 2;
  elsif  r < 0.985 then multiplicador := 3;
  else                  multiplicador := 10;
  end if;

  v_ganancia := round(p_apuesta * multiplicador);
  v_out := jsonb_build_object('multiplicador', multiplicador);
  return app.registrar_partida('rueda', p_apuesta, v_out, v_ganancia);
end; $$;
grant execute on function api.jugar_rueda(bigint) to jugador;

-- =====================================================================
-- EJEMPLO DE JUEGO: Tragamonedas (slots)
-- El cálculo del resultado se hace EN EL SERVIDOR, nunca confiar en el
-- navegador. El frontend solo pide "jugar" con una apuesta.
-- =====================================================================
create or replace function api.jugar_tragamonedas(p_apuesta bigint)
returns jsonb
language plpgsql security definer
as $$
declare
  simbolos text[] := array['🍒','🍋','🔔','⭐','7️⃣'];
  r1 text; r2 text; r3 text;
  v_ganancia bigint := 0;
  v_resultado jsonb;
begin
  r1 := simbolos[1 + floor(random()*5)::int];
  r2 := simbolos[1 + floor(random()*5)::int];
  r3 := simbolos[1 + floor(random()*5)::int];

  if r1 = r2 and r2 = r3 then
    v_ganancia := p_apuesta * (case r1 when '7️⃣' then 10 when '⭐' then 6 else 3 end);
  elsif r1 = r2 or r2 = r3 or r1 = r3 then
    v_ganancia := p_apuesta * 1; -- devuelve la apuesta
  end if;

  v_resultado := jsonb_build_object('carretes', jsonb_build_array(r1, r2, r3));

  return app.registrar_partida('tragamonedas', p_apuesta, v_resultado, v_ganancia);
end;
$$;

-- =====================================================================
-- PERMISOS: PostgREST solo puede hacer lo que le demos explícitamente
-- =====================================================================
grant usage on schema api to anon, jugador, admin_role;
grant execute on function api.mi_saldo() to jugador, admin_role;
grant execute on function api.jugar_tragamonedas(bigint) to jugador;
grant execute on function api.admin_crear_usuario(text, text) to admin_role; -- (username, password en texto plano; se hashea server-side)
grant execute on function api.admin_cargar_fichas(uuid, bigint) to admin_role;

-- Datos iniciales: catálogo de juegos
insert into app.juegos (id, nombre, apuesta_min, apuesta_max) values
  ('tragamonedas', 'Tragamonedas', 10, 1000),
  ('moneda', 'Cara o Cruz', 10, 1000),
  ('dados', 'Dados', 10, 1000),
  ('hilo', 'Alto o Bajo', 10, 1000),
  ('carta_alta', 'Carta Más Alta', 10, 1000),
  ('ruleta', 'Ruleta', 10, 1000),
  ('keno', 'Keno', 10, 1000),
  ('rasca', 'Rasca y Gana', 10, 1000),
  ('rueda', 'Rueda de la Suerte', 10, 1000);
