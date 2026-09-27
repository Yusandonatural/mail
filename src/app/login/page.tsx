export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="login">
      <h1>悠三堂メール</h1>
      <p className="meta">yusando.com の Google アカウントでログインします。</p>
      {error ? <div className="banner error">{error}</div> : null}
      <p>
        <a className="button primary" href="/api/auth/login" style={{ background: "var(--accent)", color: "#fff" }}>
          Google でログイン
        </a>
      </p>
    </div>
  );
}
