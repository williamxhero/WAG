"""Static/stdlib fake tests only. NEVER execute the native CLI or child."""
from pathlib import Path
import ast
import ctypes
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).parent
SOURCE=(ROOT/'one_root_preflight.py').read_text(encoding='utf-8')
TREE=ast.parse(SOURCE)
compile(SOURCE, 'one_root_preflight.py', 'exec')
# A strict top-level whitelist BEFORE module execution. Only constant method
# defaults (time.monotonic) and pure class definitions are permitted.
assert all(isinstance(n,(ast.Import,ast.ImportFrom,ast.ClassDef,ast.FunctionDef,ast.If)) or
           (isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant)) for n in TREE.body)
assert len([n for n in TREE.body if isinstance(n,ast.If)]) == 1
assert ast.unparse(TREE.body[-1].test) == "__name__ == '__main__'"
for node in TREE.body:
    if isinstance(node,(ast.ClassDef,ast.FunctionDef)):
        assert not node.decorator_list
        if isinstance(node,ast.ClassDef):
            assert all(isinstance(x,(ast.FunctionDef,ast.Pass)) for x in node.body)
        else:
            assert not any(isinstance(x,ast.Call) for d in node.args.defaults for x in ast.walk(d))
module=types.ModuleType('static_candidate')
module.__file__=str(ROOT/'one_root_preflight.py')
exec(compile(TREE,'one_root_preflight.py','exec'),module.__dict__)

class Clock:
    def __init__(self): self.now=0.0
    def __call__(self): return self.now

class Fake:
    def __init__(self,budget,clock,fail=None,late=None):
        self.budget=budget;self.clock=clock;self.fail=fail;self.late=late
        self.calls=[];self.owned=False;self.closed=False
    def action(self,name,normal=None):
        self.calls.append(name)
        if self.late==name: self.clock.now=61.0
        if self.fail==name: raise module.Fault(5)
        return normal
    def prepare(self): self.action('prepare')
    def create(self,ms): self.owned=True; self.action('create')
    def identity(self): return self.action('identity',True)
    def birth_evidence(self): return {'creation_filetime':123,'created_pid':10,'created_tid':11}
    def resume(self): return self.action('resume',1)
    def wait_ready(self,ms): return self.action('wait_ready',0)
    def alive(self): return self.action('alive',True)
    def go(self): self.action('go')
    def wait_root(self,ms): return self.action('wait_root',0)
    def exit_code(self): return self.action('exit_code',0)
    def reset_ready(self): self.action('reset_ready')
    def sample(self): return self.action('sample',True)
    def pace(self,ms):
        self.clock.now+=ms/1000
        return self.action('pace',258)
    def cleanup(self,report):
        self.closed=True;self.action('cleanup')
        if self.owned and not report['actual_exit']:
            report['terminate_requested']=True
            report['terminate_succeeded']=True
            if self.clock.now<self.budget.deadline: report['actual_exit']=True

class StaticTests(unittest.TestCase):
    def run_fake(self,fail=None,late=None,override=None):
        clock=Clock(); holder=[]
        def factory(budget):
            fake=Fake(budget,clock,fail,late)
            if override: override(fake)
            holder.append(fake);return fake
        report,budget=module.run_state(factory,clock)
        self.assertTrue(holder[0].closed)
        self.assertEqual(budget.deadline,60)
        self.assertFalse(report['evidence_complete'])
        self.assertNotIn(report['result'],('PASS','SINGLE_ROOT_PASS'))
        return report,holder[0]
    def test_candidate_only_not_pass(self):
        r,b=self.run_fake()
        self.assertTrue(r['candidate']);self.assertTrue(r['natural_exit'])
        self.assertGreaterEqual(r['resource_seconds'],6)
        self.assertGreater(r['samplecount'],2)
        self.assertEqual(b.calls.count('resume'),1)
    def test_slow_samples_are_not_a_six_second_observation(self):
        def change(b):
            def sample():
                b.clock.now += 6.1
                return b.action('sample',True)
            b.sample=sample
        r,b=self.run_fake(override=change)
        self.assertFalse(r['candidate'])
    def test_observation_excludes_first_query_time(self):
        samples=[]
        def change(b):
            def sample():
                if not samples: b.clock.now += 6.1
                samples.append(b.clock.now)
                return b.action('sample',True)
            b.sample=sample
        r,b=self.run_fake(override=change)
        self.assertTrue(r['candidate'])
        self.assertGreaterEqual(samples[-1]-samples[0],6)
        self.assertGreater(len(samples),2)
        self.assertAlmostEqual(r['resource_seconds'],samples[-1]-samples[0])
        self.assertLess(b.clock.now,b.budget.deadline)
    def test_slow_first_sample_leaves_no_observation_budget(self):
        def change(b):
            def sample():
                b.clock.now=55
                return b.action('sample',True)
            b.sample=sample
        r,b=self.run_fake(override=change)
        self.assertEqual(r['result'],'TIMEOUT')
        self.assertFalse(r['candidate'])
    def test_observation_without_intermediate_sample_is_not_candidate(self):
        samples=[]
        def change(b):
            def sample():
                if samples: b.clock.now += 6.1
                samples.append(b.clock.now)
                return b.action('sample',True)
            b.sample=sample
        r,b=self.run_fake(override=change)
        self.assertFalse(r['candidate'])
    def test_first_failure_never_resumes(self):
        for stage in ('prepare','create','identity'):
            with self.subTest(stage=stage):
                r,b=self.run_fake(fail=stage)
                self.assertNotIn('resume',b.calls);self.assertFalse(r['candidate'])
    def test_false_identity_never_resumes(self):
        r,b=self.run_fake(override=lambda b:setattr(b,'identity',lambda:False))
        self.assertNotIn('resume',b.calls);self.assertTrue(r['terminate_requested'])
    def test_resume_abnormal_no_retry(self):
        for value in (0,2,0xFFFFFFFF):
            with self.subTest(value=value):
                def change(b): b.resume=lambda:b.action('resume',value)
                r,b=self.run_fake(override=change)
                self.assertEqual(b.calls.count('resume'),1)
                self.assertNotIn('go',b.calls);self.assertFalse(r['candidate'])
    def test_failure_stops_next_phase(self):
        for stage in ('resume','wait_ready','alive','go','wait_root','exit_code','reset_ready','sample','pace'):
            with self.subTest(stage=stage):
                r,b=self.run_fake(fail=stage)
                self.assertFalse(r['candidate'])
                self.assertEqual(b.calls[-1],'cleanup')
    def test_ready_wait_timeout_no_go(self):
        r,b=self.run_fake(override=lambda b:setattr(b,'wait_ready',lambda ms:258))
        self.assertEqual(r['result'],'TIMEOUT');self.assertNotIn('go',b.calls)
    def test_root_wait_timeout_not_natural(self):
        r,b=self.run_fake(override=lambda b:setattr(b,'wait_root',lambda ms:258))
        self.assertEqual(r['result'],'TIMEOUT');self.assertFalse(r['natural_exit'])
    def test_failed_native_wait_preserves_error_in_report(self):
        for role in ('wait_ready','wait_root'):
            for error in (6,87):
                with self.subTest(role=role,error=error):
                    def change(b):
                        n=module.Native.__new__(module.Native)
                        n.budget=b.budget;n.ready=101;n.process=102
                        n.c=types.SimpleNamespace(get_last_error=lambda:error)
                        n.k=types.SimpleNamespace(WaitForSingleObject=lambda *a:0xFFFFFFFF)
                        setattr(b,role,getattr(n,role))
                    r,b=self.run_fake(override=change)
                    self.assertEqual(r['result'],'UNKNOWN')
                    self.assertEqual(r['winerror'],error)
                    self.assertFalse(r['deadline_overrun'])
                    self.assertFalse(r['candidate'])
    def test_late_failed_wait_keeps_error_and_deadline(self):
        def change(b):
            n=module.Native.__new__(module.Native)
            n.budget=b.budget;n.ready=101
            n.c=types.SimpleNamespace(get_last_error=lambda:6)
            def wait(*args):
                b.clock.now=61
                return 0xFFFFFFFF
            n.k=types.SimpleNamespace(WaitForSingleObject=wait)
            b.wait_ready=n.wait_ready
        r,b=self.run_fake(override=change)
        self.assertEqual(r['result'],'TIMEOUT')
        self.assertEqual(r['winerror'],6)
        self.assertTrue(r['deadline_overrun'])
        self.assertFalse(r['candidate'])
    def test_unexpected_wait_result_is_not_timeout(self):
        for role in ('wait_ready','wait_root'):
            with self.subTest(role=role):
                r,b=self.run_fake(override=lambda b:setattr(b,role,lambda ms:128))
                self.assertEqual(r['result'],'UNKNOWN')
                self.assertFalse(r['candidate'])
    def test_failed_cleanup_wait_preserves_numeric_error(self):
        def change(b):
            n=module.Native.__new__(module.Native)
            n.budget=b.budget;n.process=101;n.handles=[101]
            n.attributes_initialized=False
            error=[6]
            n.c=types.SimpleNamespace(get_last_error=lambda:error[0])
            def close(handle):
                error[0]=87
                return 1
            n.k=types.SimpleNamespace(
                TerminateProcess=lambda *a:1,
                WaitForSingleObject=lambda *a:0xFFFFFFFF,
                CloseHandle=close,
            )
            b.identity=lambda:False
            b.cleanup=lambda report:(setattr(b,'closed',True),n.cleanup(report))
        r,b=self.run_fake(override=change)
        self.assertEqual(r['result'],'UNKNOWN')
        self.assertEqual(r['winerror'],6)
        self.assertEqual(r['cleanup_failures'],1)
        self.assertFalse(r['actual_exit'])
        self.assertFalse(r['candidate'])
    def test_deadline_every_phase(self):
        for stage in ('prepare','create','identity','resume','wait_ready','alive','go','wait_root','exit_code','reset_ready','sample','pace','cleanup'):
            with self.subTest(stage=stage):
                r,b=self.run_fake(late=stage)
                self.assertEqual(r['result'],'TIMEOUT');self.assertFalse(r['candidate'])
    def test_initial_expiry_no_factory(self):
        values=iter((0,61,61))
        r,_=module.run_state(lambda _:self.fail('factory after deadline'),lambda:next(values))
        self.assertEqual(r['result'],'TIMEOUT')
    def test_six_seconds_insufficient(self):
        def change(b):
            original=b.wait_root
            def wait(ms):
                value=original(ms); b.clock.now=55;return value
            b.wait_root=wait
        r,b=self.run_fake(override=change)
        self.assertEqual(r['result'],'TIMEOUT');self.assertFalse(r['candidate'])
    def test_nonzero_exit_not_natural(self):
        r,b=self.run_fake(override=lambda b:setattr(b,'exit_code',lambda:95))
        self.assertFalse(r['natural_exit']);self.assertFalse(r['candidate'])
    def test_bad_resource_sample(self):
        r,b=self.run_fake(override=lambda b:setattr(b,'sample',lambda:False))
        self.assertFalse(r['candidate']);self.assertEqual(r['resource_seconds'],0)
    def test_cleanup_error_no_candidate(self):
        r,b=self.run_fake(fail='cleanup')
        self.assertEqual(r['cleanup_failures'],1);self.assertFalse(r['candidate'])
    def test_budget_floor_no_infinite(self):
        clock=Clock();b=module.Budget(clock);clock.now=59.9999
        with self.assertRaises(module.Deadline):b.milliseconds()
    def test_static_creation_contract(self):
        n=next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='Native')
        methods={m.name:ast.unparse(m) for m in n.body}
        self.assertIn('0x2000D',SOURCE);self.assertIn('0x20002',SOURCE)
        self.assertNotIn('AssignProcessToJobObject',SOURCE)
        self.assertNotIn('OpenProcess',SOURCE)
        self.assertIn('0x00080000 | 0x00000004 | 0x00000400 | 0x08000000',SOURCE)
        self.assertIn('self.process, self.job',methods['identity'])
        self.assertIn('self.process',methods['identity'])
        self.assertIn('self.job_array',methods['prepare'])
        self.assertIn('DeleteProcThreadAttributeList',methods['cleanup'])
    def bind_fake(self):
        class Function:
            def __call__(self,*args): raise AssertionError('No API call in binding test')
        class Kernel:
            def __init__(self):self.functions={}
            def __getattr__(self,name):return self.functions.setdefault(name,Function())
        n=module.Native.__new__(module.Native)
        kernel=Kernel()
        with patch.object(ctypes,'WinDLL',return_value=kernel,create=True):n._bind()
        return n,kernel
    def test_signatures_and_layout_without_dll(self):
        n,k=self.bind_fake()
        self.assertEqual(ctypes.sizeof(n.U32),4)
        self.assertEqual(ctypes.sizeof(n.HANDLE),ctypes.sizeof(ctypes.c_void_p))
        expected={8:(144,216,48,16,104,112,24),4:(48,144,48,12,68,72,16)}
        sizes=tuple(ctypes.sizeof(t) for t in (n.ExtendedLimit._fields_[0][1],n.ExtendedLimit,n.Accounting,n.PidList,n.StartupEx._fields_[0][1],n.StartupEx,n.ProcessInfo))
        # BASIC_LIMIT x64=64 bytes, checked against SDK field alignment below.
        expected[8]=(64,144,48,16,104,112,24)
        self.assertEqual(sizes,expected[ctypes.sizeof(ctypes.c_void_p)])
        self.assertEqual(k.CreateProcessW.restype,ctypes.c_int32)
        self.assertEqual(k.UpdateProcThreadAttribute.argtypes[2],ctypes.c_size_t)
        self.assertIsNone(k.DeleteProcThreadAttributeList.restype)
    def test_identity_each_evidence_failure_no_resume(self):
        for failure in ('pid','tid','threadowner','birth','job','alive'):
            n,k=self.bind_fake();n.job=1;n.ready=2;n.go_event=3;n.process=4;n.thread=5
            n.info=types.SimpleNamespace(pid=10,tid=11)
            n.noninherit=lambda h:None;n.alive=lambda:failure!='alive'
            def call(name,*args):
                if name=='GetProcessId':return 0 if failure=='pid' else 10
                if name=='GetThreadId':return 0 if failure=='tid' else 11
                if name=='GetProcessIdOfThread':return 0 if failure=='threadowner' else 10
                if name=='GetProcessTimes':args[1]._obj.low=0 if failure=='birth' else 123;return 1
                if name=='IsProcessInJob':
                    self.assertEqual(args[1],n.job)
                    args[2]._obj.value=int(failure!='job');return 1
                self.fail(name)
            n.call=call
            self.assertFalse(n.identity(),failure)
    def test_native_sample_each_resource_condition(self):
        for bad in ('none','active','total','assigned','listed','root'):
            n,k=self.bind_fake();n.job=99;n.wait_root=lambda ms:258 if bad=='root' else 0
            def call(name,job,kind,pointer,*rest):
                self.assertEqual(job,99)
                obj=pointer._obj
                if kind==1:
                    obj.total=2 if bad=='total' else 1;obj.active=int(bad=='active')
                else:
                    obj.assigned=int(bad=='assigned');obj.listed=int(bad=='listed')
                return 1
            n.call=call
            self.assertEqual(n.sample(),bad=='none')
    def test_native_late_create_registration(self):
        clock=Clock();n=module.Native.__new__(module.Native);n.budget=module.Budget(clock)
        n.c=types.SimpleNamespace(get_last_error=lambda:0)
        def acquire():clock.now=61;return 123
        n.k=types.SimpleNamespace(acquire=acquire);registered=[]
        with self.assertRaises(module.Deadline):n.call('acquire',register=registered.append)
        self.assertEqual(registered,[123])
    def test_native_cleanup_continues_and_never_fake_exit(self):
        n,k=self.bind_fake();clock=Clock();n.budget=module.Budget(clock);clock.now=61
        n.handles=[1,2,3];n.process=44;n.attributes_initialized=True
        n.attribute_buffer=object();n.job_array=object();n.inherit_array=object()
        closed=[];order=[]
        def close(h):closed.append(h);return h!=2
        n.k=types.SimpleNamespace(TerminateProcess=lambda *a:1,WaitForSingleObject=lambda *a:self.fail('wait after deadline'),CloseHandle=close,DeleteProcThreadAttributeList=lambda b:order.append('delete'))
        report={'actual_exit':False,'winerror':0,'cleanup_failures':0,'handle_close_failures':0}
        with patch.object(ctypes,'get_last_error',return_value=6,create=True):n.cleanup(report)
        self.assertEqual(closed,[3,2,1]);self.assertEqual(order,['delete'])
        self.assertTrue(report['terminate_requested']);self.assertFalse(report['actual_exit'])
        self.assertEqual(report['handle_close_failures'],1)
    def test_output_whitelist(self):
        r,b=self.run_fake()
        allowed={'result','phase','winerror','candidate','ownership','actual_exit','natural_exit','terminate_requested','terminate_succeeded','resource_seconds','samplecount','handle_close_failures','cleanup_failures','deadline_overrun','evidence_complete','creation_filetime','created_pid','created_tid'}
        self.assertEqual(set(r),allowed)

if __name__=='__main__':
    with patch.object(ctypes,'WinDLL',side_effect=AssertionError('Native DLL forbidden'),create=True):
        unittest.main(verbosity=2)
