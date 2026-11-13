"""테스트용 PDF 생성: 구형 xref 표, 객체 스트림, 선형화, 회전/CropBox, 첨부 포함, 암호화."""
import sys, hashlib, pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter

out = sys.argv[1]

def base(path, pages=3, size=A4):
    c = canvas.Canvas(path, pagesize=size)
    for i in range(pages):
        c.setFont("Helvetica", 28)
        c.drawString(72, size[1] - 100, f"PadNote fixture page {i + 1}")
        c.setFont("Helvetica", 12)
        for k in range(30):
            c.drawString(72, size[1] - 150 - k * 20, f"line {k + 1}: the quick brown fox jumps over the lazy dog")
        c.rect(72, 72, size[0] - 144, 40)
        c.showPage()
    c.save()

def fresh_id(p, name):
    """파생 파일이 원본과 같은 /ID(=같은 문서)로 취급되지 않게 한다."""
    h = hashlib.md5(name.encode()).digest()
    p.trailer.ID = pikepdf.Array([pikepdf.String(h), pikepdf.String(h)])

base(f"{out}/plain.pdf")                       # PDF 1.3, 고전 xref 표
with pikepdf.open(f"{out}/plain.pdf") as p:    # 객체 스트림 + xref 스트림
    fresh_id(p, "objstm")
    p.save(f"{out}/objstm.pdf", object_stream_mode=pikepdf.ObjectStreamMode.generate)
with pikepdf.open(f"{out}/plain.pdf") as p:    # 선형화
    fresh_id(p, "linear")
    p.save(f"{out}/linear.pdf", linearize=True)
with pikepdf.open(f"{out}/plain.pdf") as p:    # 회전 + CropBox 오프셋 + UserUnit
    p.pages[0].Rotate = 90
    p.pages[1].Rotate = 270
    p.pages[1].CropBox = [50, 80, 500, 700]
    p.pages[2].Rotate = 180
    p.pages[2].UserUnit = 2
    fresh_id(p, "rotated")
    p.save(f"{out}/rotated.pdf")
with pikepdf.open(f"{out}/plain.pdf") as p:    # 기존 첨부 + 공유/상속 리소스
    p.attachments["zeta.txt"] = b"zeta"
    p.attachments["alpha.txt"] = b"alpha"
    res = p.make_indirect(p.pages[0].Resources)
    res.ExtGState = pikepdf.Dictionary(GS0=pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, CA=1))
    p.Root.Pages.Resources = res
    for pg in p.pages:
        del pg.obj["/Resources"]
    fresh_id(p, "attach")
    p.save(f"{out}/attach.pdf", object_stream_mode=pikepdf.ObjectStreamMode.generate)
with pikepdf.open(f"{out}/plain.pdf") as p:    # 암호화(사용자 암호 없음 / 있음)
    fresh_id(p, "enc")
    p.save(f"{out}/enc-owner.pdf", encryption=pikepdf.Encryption(owner="owner", user="", R=6))
    p.save(f"{out}/enc-user.pdf", encryption=pikepdf.Encryption(owner="owner", user="secret", R=4))
base(f"{out}/big.pdf", pages=120, size=letter)
print("ok")
