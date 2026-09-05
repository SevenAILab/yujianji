'use client';

import { ArrowLeft, Calendar, ChevronRight, Download, Footprints, Heart, MapPin, Route, Share2, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppNav } from '@/components/AppNav';

const ROUTES = [
  { id: 'bund', title: '外滩晨光线', author: '林间散步', place: '上海 · 黄浦江', distance: '6.8 km', time: '1h 42m', level: '轻松', image: '/seed/white-cliff.jpg', likes: 328 },
  { id: 'moganshan', title: '莫干山竹林秘境', author: '山野电台', place: '浙江 · 德清', distance: '12.4 km', time: '3h 16m', level: '中等', image: '/seed/pink-leaf-real.jpg', likes: 196 },
  { id: 'coast', title: '海风与灯塔', author: '沿海公路', place: '山东 · 长岛', distance: '24.1 km', time: '6h 05m', level: '挑战', image: '/seed/beach-lighthouse.jpg', likes: 514 },
];

export default function CommunityPage() {
  const router = useRouter(); const [copied, setCopied] = useState<string | null>(null);
  function copyRoute(id: string) { setCopied(id); try { localStorage.setItem('yujianji-imported-route', id); } catch { /* private mode */ } window.setTimeout(() => setCopied(null), 2200); }
  return <main className="app-shell"><div className="phone-page community-page"><header className="page-header"><button className="icon-action" onClick={() => router.back()} aria-label="返回"><ArrowLeft size={18} /></button><div className="brand-lockup"><h1>路线社区</h1><span>GO FURTHER</span></div><Users size={19} color="var(--teal)" /></header><section className="community-intro"><p className="eyebrow">和同频的人一起出发</p><h2>把走过的路，分享给下一位旅人</h2><p>复制一条喜欢的路线，导入手机或手表，沿着别人的脚印去遇见新的风景。</p></section><div className="community-tabs"><button className="active">推荐路线</button><button>附近的人</button><button>我的收藏</button></div><div className="route-feed">{ROUTES.map(route => <article className="route-post surface" key={route.id}><img src={route.image} alt="" /><div className="route-post-body"><div className="route-post-head"><div><h3>{route.title}</h3><span><MapPin size={12} /> {route.place}</span></div><button className="like-button" aria-label="喜欢"><Heart size={16} />{route.likes}</button></div><div className="route-stats"><span><Footprints size={14} />{route.distance}</span><span><Calendar size={14} />{route.time}</span><span><Route size={14} />{route.level}</span></div><div className="route-author">头像 · {route.author}</div><button className={copied === route.id ? 'route-import copied' : 'route-import'} onClick={() => copyRoute(route.id)}>{copied === route.id ? '已导入到我的旅程' : '复制路线'}{copied === route.id ? <Share2 size={15} /> : <Download size={15} />}</button></div></article>)}</div><div className="community-note"><Route size={16} /><span>路线会先在你的设备上预览，确认后再开始记录。导出的 GPX 文件可导入支持的手表。</span><ChevronRight size={15} /></div></div><AppNav /></main>;
}
