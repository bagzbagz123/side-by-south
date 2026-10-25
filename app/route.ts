import landingHtml from '../lib/landing-html';
export async function GET(){return new Response(landingHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=0, must-revalidate'}});}
