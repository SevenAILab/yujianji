import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import styles from "../legal.module.css";
import { PRIVACY_UPDATED_AT } from "@/lib/consent";

export const metadata = {
  title: "用户协议 · 遇见集",
  description: "使用遇见集前请阅读本协议。",
};

export default function TermsPage() {
  return (
    <main className="app-shell">
      <div className={styles.page}>
        <Link className={styles.back} href="/me">
          <ArrowLeft size={15} />
          返回
        </Link>
        <article className={styles.doc}>
          <h1>用户协议</h1>
          <p className={styles.updated}>更新于 {PRIVACY_UPDATED_AT}</p>

          <p className={styles.draft}>
            本版本为公开测试版协议。正式商业运营前，本文将由法律专业人士复核并可能调整。
          </p>

          <h2>一、这是什么</h2>
          <p>
            遇见集是一个处于<strong>公开测试阶段</strong>的旅行记录工具。
            你拍一张照片、说一句话，AI 会生成一页遇见记录，并对照你的历史判断这是「初见」还是「重逢」。
          </p>

          <h2>二、测试阶段的限制</h2>
          <ul>
            <li>功能可能随时调整、暂停或下线，恕不另行通知。</li>
            <li>为控制模型成本，单设备每小时和每天的识别次数有上限；全站每日总量也有上限。</li>
            <li>
              <strong>你的数据只保存在本机浏览器</strong>，我们无法为你找回。
              请务必定期在「我的」页导出备份。
            </li>
          </ul>

          <h2>三、你不可以做的事</h2>
          <ul>
            <li>上传违法、侵权、暴力、色情或涉及他人隐私的内容。</li>
            <li>上传含有他人可识别信息（人脸、证件、住址、车牌等）而未获其同意的照片。</li>
            <li>使用脚本、爬虫或其他自动化手段批量调用接口。</li>
            <li>对服务进行逆向、干扰、攻击，或试图绕过用量限制。</li>
          </ul>
          <p>
            我们可以在发现上述行为时，限制或终止相关设备的使用，无需事先通知。
          </p>

          <h2>四、内容与责任</h2>
          <p>
            你对自己上传的内容负责，并保证拥有相应权利。
            AI 生成的解读、知识、趣闻和「幸运」判断<strong>可能包含错误</strong>，
            仅供娱乐与参考，<strong>不构成物种鉴定、医疗、安全、导航或法律建议</strong>。
            在户外活动中，请以自身判断和专业信息为准。
          </p>
          <p>
            健康相关数据（如有）仅作为参考提示，<strong>不是医疗诊断</strong>，
            不能用于判断你是否适合进行某项活动。
          </p>

          <h2>五、举报</h2>
          <p>
            如果你发现 AI 生成了不当内容，或收到他人分享的违规内容，
            请通过<Link href="/feedback">反馈页面</Link>告诉我们。
          </p>

          <h2>六、服务可用性</h2>
          <p>
            测试阶段不对可用性作出承诺。在法律允许的最大范围内，
            我们不对因使用或无法使用本服务造成的损失承担责任。
          </p>

          <h2>七、联系</h2>
          <p>
            问题、意见或投诉请通过<Link href="/feedback">反馈页面</Link>提交。
          </p>
        </article>
      </div>
    </main>
  );
}
