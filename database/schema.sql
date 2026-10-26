-- Esquema de auth_db (auth-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: consentimientos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consentimientos (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    documento character varying(20) NOT NULL,
    version character varying(20) NOT NULL,
    aceptado_en timestamp with time zone NOT NULL
);


--
-- Name: email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    email character varying NOT NULL,
    code_hash character varying NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_challenges (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    channel character varying NOT NULL,
    code_hash character varying,
    phone character varying(16),
    expires_at timestamp with time zone NOT NULL,
    last_sent_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: phone_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_verifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    phone character varying NOT NULL,
    firebase_uid character varying,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sesiones_activas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sesiones_activas (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    refresh_token_hash character varying NOT NULL,
    mfa_verified boolean DEFAULT false NOT NULL,
    activa boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    username character varying(40) NOT NULL,
    nombre character varying(120) NOT NULL,
    password_hash character varying NOT NULL,
    role character varying DEFAULT 'support'::character varying NOT NULL,
    active boolean DEFAULT true NOT NULL,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    documento_hash character varying(64),
    sessions_valid_after timestamp with time zone
);


--
-- Name: usuarios_auth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios_auth (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    email character varying NOT NULL,
    username character varying(30),
    password_hash character varying NOT NULL,
    password_hash_version smallint DEFAULT '1'::smallint NOT NULL,
    mfa_secret character varying,
    mfa_enabled boolean DEFAULT false NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    blocked_until timestamp with time zone,
    recovery_failed_attempts integer DEFAULT 0 NOT NULL,
    recovery_blocked boolean DEFAULT false NOT NULL,
    dynamic_key_failures integer DEFAULT 0 NOT NULL,
    dynamic_key_locked_until timestamp with time zone,
    disabled_by_bank boolean DEFAULT false NOT NULL,
    disabled_reason character varying(300),
    disabled_at timestamp with time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: usuarios_auth PK_039686fb173f7c59dff29b535d4; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_auth
    ADD CONSTRAINT "PK_039686fb173f7c59dff29b535d4" PRIMARY KEY (id);


--
-- Name: phone_verifications PK_11ef2c1c5ed828b9636472db666; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_verifications
    ADD CONSTRAINT "PK_11ef2c1c5ed828b9636472db666" PRIMARY KEY (id);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: email_verifications PK_c1ea2921e767f83cd44c0af203f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT "PK_c1ea2921e767f83cd44c0af203f" PRIMARY KEY (id);


--
-- Name: staff_users PK_c6b167335377df69f7910c2c75e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_users
    ADD CONSTRAINT "PK_c6b167335377df69f7910c2c75e" PRIMARY KEY (id);


--
-- Name: event_outbox PK_c8bd4a6797caa3ebad9b40c9813; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT "PK_c8bd4a6797caa3ebad9b40c9813" PRIMARY KEY (id);


--
-- Name: password_reset_challenges PK_cc9cdb37ae2b843c92f2436c1c5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_challenges
    ADD CONSTRAINT "PK_cc9cdb37ae2b843c92f2436c1c5" PRIMARY KEY (id);


--
-- Name: sesiones_activas PK_d7492c6916667a67d04b84a4bd5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sesiones_activas
    ADD CONSTRAINT "PK_d7492c6916667a67d04b84a4bd5" PRIMARY KEY (id);


--
-- Name: usuarios_auth UQ_3b437031aaf9e1d2c9dbf33c041; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_auth
    ADD CONSTRAINT "UQ_3b437031aaf9e1d2c9dbf33c041" UNIQUE (email);


--
-- Name: consentimientos PK_1b96bdc227c38546461897bb580; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consentimientos
    ADD CONSTRAINT "PK_1b96bdc227c38546461897bb580" PRIMARY KEY (id);


--
-- Name: IDX_25c7fc1787664a823be035ab11; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_25c7fc1787664a823be035ab11" ON public.email_verifications USING btree (id_user);


--
-- Name: IDX_3b437031aaf9e1d2c9dbf33c04; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_3b437031aaf9e1d2c9dbf33c04" ON public.usuarios_auth USING btree (email);


--
-- Name: IDX_3f2ecafd4160def1a0d99dd2e5; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_3f2ecafd4160def1a0d99dd2e5" ON public.usuarios_auth USING btree (username);


--
-- Name: IDX_6543110a244519b0da53435c47; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_6543110a244519b0da53435c47" ON public.phone_verifications USING btree (phone);


--
-- Name: IDX_7beb141cae6518dd951319791b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7beb141cae6518dd951319791b" ON public.sesiones_activas USING btree (id_user);


--
-- Name: IDX_8409947a58b7ac31a97d6916bf; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_8409947a58b7ac31a97d6916bf" ON public.phone_verifications USING btree (id_user);


--
-- Name: IDX_8c20bf986bad27f5d51ba82b77; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_8c20bf986bad27f5d51ba82b77" ON public.usuarios_auth USING btree (id_user);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_912b4ef3698d94b50a56ccf1b5; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_912b4ef3698d94b50a56ccf1b5" ON public.password_reset_challenges USING btree (id_user);


--
-- Name: IDX_975b4ddfa7b30b64ac26cefbad; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_975b4ddfa7b30b64ac26cefbad" ON public.staff_users USING btree (username);


--
-- Name: IDX_cfa0e555c97ddad104745ea40c; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_cfa0e555c97ddad104745ea40c" ON public.sesiones_activas USING btree (refresh_token_hash);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_event_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_outbox_pending ON public.event_outbox USING btree (published_at, created_at);


--
-- Name: uq_consentimientos_usuario_documento_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_consentimientos_usuario_documento_version ON public.consentimientos USING btree (id_user, documento, version);


--
-- PostgreSQL database dump complete
--


