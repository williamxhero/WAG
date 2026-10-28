"""One-session orchestration. Importing does not construct any real port."""
import receipt_model as model
from metadata_adapter import observe_tool_identities
from host_adapter import observe_fixed_host
from publication import Publisher, encode


class Deadline:
    def __init__(self, clock, start_ns=None):
        self.clock = clock
        self.last = self.now()
        self.start = self.last if start_ns is None else start_ns
        if type(self.start) is not int or not 0 <= self.start <= self.last:
            raise ValueError()
    def now(self):
        value = self.clock()
        if type(value) is not int or not 0 <= value < 2**63:
            raise ValueError()
        return value
    def check(self):
        value = self.now()
        if value < self.last or value - self.start >= 30000000000:
            raise TimeoutError()
        self.last = value
    def wait_ms(self):
        self.check()
        return min(10, (30000000000 - (self.last - self.start)) // 1000000)


def run_once(ports):
    if ports.used:
        return dict(result='SESSION_ALREADY_CONSUMED', execution_authority=False)
    ports.used = True
    result = dict(result='UNKNOWN_OR_INCOMPLETE', publication_complete=False,
                  host_launch='NOT_RUN', metadata=None, host=None,
                  assessment=dict(result='UNKNOWN_OR_INCOMPLETE', execution_authority=False),
                  errors=[])
    try:
        deadline = Deadline(ports.clock, getattr(ports, 'start_ns', None))
        publisher = Publisher(ports.files, deadline)
        deadline.check()
        ports.files.prepare_root()
        deadline.check()
        publisher.put('attempt.json', encode(dict(session=1,
                                                  maximum_host_launches=int(ports.host_admitted is True),
                                                  execution_authority=False)))
        metadata = result['metadata'] = observe_tool_identities(ports.metadata, deadline)
        host = None
        if metadata['result'] == 'IDENTITIES_OBSERVED' and ports.host_admitted is True:
            result['host_launch'] = 'ATTEMPTED'
            ports.host.deadline = deadline
            host = result['host'] = observe_fixed_host(ports.host, deadline)
            result['host_launch'] = 'CREATED' if ports.host.created else 'CREATION_NOT_OBSERVED'
        raw_host = None if host is None else {name: (value.hex() if type(value) is bytes else value)
                                              for name, value in host.items()}
        publisher.put('observation.json', encode(dict(metadata=metadata, host=raw_host,
                                                       start_ns=deadline.start,
                                                       host_launch=result['host_launch'])))
        if host is not None:
            for name in ('stdout', 'stderr'):
                if host[name] is not None:
                    publisher.put(name + '.bin', host[name])
        deadline.check()
        result['publication_complete'] = True
        result['end_ns'] = deadline.last
        receipt = dict(stdout=None if host is None else host['stdout'],
                       stderr=None if host is None else host['stderr'],
                       actual_exit=None if host is None else host['actual_exit'],
                       start_ns=deadline.start, end_ns=deadline.last,
                       drain_complete=False if host is None else host['drain_complete'],
                       timed_out=False, overflow=False, identity_checks=metadata['checks'],
                       file_validation_complete=metadata['file_validation_complete'],
                       publication_complete=True)
        if not metadata['errors'] and (host is None or not host['errors']):
            result['assessment'] = model.assess_host_receipt(receipt)
        result['result'] = result['assessment']['result']
        if metadata['result'] == 'BLOCKED_IDENTITY_DIFFERENCE':
            result['result'] = 'BLOCKED_IDENTITY_DIFFERENCE'
        elif host is None and metadata['result'] == 'IDENTITIES_OBSERVED':
            result['result'] = 'BLOCKED_TOOL_BYTE_TRUST'
        deadline.check()
    except Exception as error:
        result.update(result='UNKNOWN_OR_INCOMPLETE', publication_complete=False,
                      assessment=dict(result='UNKNOWN_OR_INCOMPLETE', execution_authority=False))
        result['errors'].append('TIME_BUDGET' if isinstance(error, TimeoutError) else 'PUBLICATION_OR_INPUT_INCOMPLETE')
    return result
